import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tracer } from '../trace/tracer.js';

/**
 * Background task context (PRD §6.23). Scheduled and event-triggered agents run
 * without an HTTP request but under the same tracing/cost/guardrail machinery
 * available to request-driven agents.
 */
export interface TaskContext {
  /** Firing time (scheduled) or when the trigger was fired. */
  now: Date;
  /** Trigger payload (webhook/queue event), if any. */
  payload?: unknown;
  /** Trace opened for this run, if a tracer is configured. */
  trace?: ReturnType<Tracer['start']>;
}

export interface ScheduledTask {
  name: string;
  /** 5-field cron: minute hour day-of-month month day-of-week. */
  cron: string;
  run: (ctx: TaskContext) => unknown | Promise<unknown>;
}

export interface TriggerTask {
  name: string;
  run: (ctx: TaskContext) => unknown | Promise<unknown>;
}

export function defineSchedule(task: ScheduledTask): ScheduledTask {
  return task;
}

export function defineTrigger(task: TriggerTask): TriggerTask {
  return task;
}

// ── Cron ────────────────────────────────────────────────────────────

/** Match a 5-field cron expression against a date (local time). */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron "${expr}" — expected 5 fields`);
  const [min, hour, dom, month, dow] = fields;
  return (
    matchField(min!, date.getMinutes(), 0, 59) &&
    matchField(hour!, date.getHours(), 0, 23) &&
    matchField(dom!, date.getDate(), 1, 31) &&
    matchField(month!, date.getMonth() + 1, 1, 12) &&
    matchField(dow!, date.getDay(), 0, 6)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    let lo: number;
    let hi: number;
    if (rangePart === '*' || rangePart === undefined) {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = hi = Number(rangePart);
    }
    for (let v = lo; v <= hi; v += step) if (v === value) return true;
  }
  return false;
}

// ── Scheduler ───────────────────────────────────────────────────────

export interface SchedulerOptions {
  tracer?: Tracer;
  /** Called if a task throws — defaults to console.error. */
  onError?: (task: string, err: unknown) => void;
}

/**
 * Runs scheduled tasks. `tick(now)` fires every task whose cron matches (once
 * per minute), wrapping each run in a trace. `start()` polls every minute.
 */
export class Scheduler {
  #tasks: ScheduledTask[] = [];
  #lastRun = new Map<string, string>();
  #tracer?: Tracer;
  #onError: (task: string, err: unknown) => void;

  constructor(options: SchedulerOptions = {}) {
    this.#tracer = options.tracer;
    this.#onError = options.onError ?? ((t, e) => console.error(`[anvil] schedule "${t}" failed:`, e));
  }

  add(task: ScheduledTask): this {
    this.#tasks.push(task);
    return this;
  }

  /** Run all tasks due at `now`. Returns the names that ran. Idempotent per minute. */
  async tick(now: Date): Promise<string[]> {
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
    const ran: string[] = [];
    for (const task of this.#tasks) {
      if (this.#lastRun.get(task.name) === minuteKey) continue;
      if (!cronMatches(task.cron, now)) continue;
      this.#lastRun.set(task.name, minuteKey);
      ran.push(task.name);
      await this.#runTask(task, { now });
    }
    return ran;
  }

  /** Poll on an interval (default every minute). Returns a stop function. */
  start(intervalMs = 60_000): () => void {
    const timer = setInterval(() => void this.tick(new Date()), intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }

  async #runTask(task: ScheduledTask, ctx: Omit<TaskContext, 'trace'>): Promise<void> {
    const trace = this.#tracer?.start(`schedule ${task.name}`, { cron: task.cron });
    try {
      await task.run({ ...ctx, trace });
      trace?.end('ok');
    } catch (err) {
      trace?.end('error');
      this.#onError(task.name, err);
    }
  }
}

// ── Triggers ────────────────────────────────────────────────────────

export interface TriggerRegistryOptions {
  tracer?: Tracer;
}

/** Named event triggers (webhook/queue). `fire(name, payload)` runs the handler. */
export class TriggerRegistry {
  #tasks = new Map<string, TriggerTask>();
  #tracer?: Tracer;

  constructor(options: TriggerRegistryOptions = {}) {
    this.#tracer = options.tracer;
  }

  register(task: TriggerTask): this {
    this.#tasks.set(task.name, task);
    return this;
  }

  has(name: string): boolean {
    return this.#tasks.has(name);
  }

  async fire(name: string, payload?: unknown, now = new Date()): Promise<unknown> {
    const task = this.#tasks.get(name);
    if (!task) throw new Error(`No trigger registered: "${name}"`);
    const trace = this.#tracer?.start(`trigger ${name}`, {});
    try {
      const result = await task.run({ now, payload, trace });
      trace?.end('ok');
      return result;
    } catch (err) {
      trace?.end('error');
      throw err;
    }
  }
}

// ── Discovery ───────────────────────────────────────────────────────

export interface BackgroundTasks {
  schedules: ScheduledTask[];
  triggers: TriggerTask[];
}

const SOURCE_EXT = new Set(['.ts', '.mts', '.js', '.mjs']);
type Importer = (file: string) => Promise<unknown>;
const defaultImporter: Importer = (file) => import(pathToFileURL(file).href);

/**
 * Scan a directory tree for `schedule.ts` / `trigger.ts` files, importing each
 * default-exported descriptor (from defineSchedule/defineTrigger). The task
 * name defaults to its folder path.
 */
export async function loadBackgroundTasks(dir: string, importer: Importer = defaultImporter): Promise<BackgroundTasks> {
  const schedules: ScheduledTask[] = [];
  const triggers: TriggerTask[] = [];
  await walk(path.resolve(dir), '', schedules, triggers, importer);
  return { schedules, triggers };
}

async function walk(dir: string, rel: string, schedules: ScheduledTask[], triggers: TriggerTask[], importer: Importer): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, rel ? `${rel}/${entry.name}` : entry.name, schedules, triggers, importer);
      continue;
    }
    if (!entry.isFile() || !SOURCE_EXT.has(path.extname(entry.name)) || entry.name.endsWith('.d.ts')) continue;
    const base = path.basename(entry.name, path.extname(entry.name));
    if (base !== 'schedule' && base !== 'trigger') continue;
    const mod = (await importer(full)) as { default?: ScheduledTask | TriggerTask };
    if (!mod.default) continue;
    const name = mod.default.name || rel || base;
    if (base === 'schedule') schedules.push({ ...(mod.default as ScheduledTask), name });
    else triggers.push({ ...(mod.default as TriggerTask), name });
  }
}

export const MODULE_STATUS = 'active' as const;

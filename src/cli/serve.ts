import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createJiti } from 'jiti';
import { serve } from '../kernel/adapter-node.js';
import { Scheduler, TriggerRegistry, loadBackgroundTasks } from '../schedule/index.js';
import { MemoryTraceStore } from '../trace/memory-store.js';
import { SqliteTraceStore } from '../trace/sqlite-store.js';
import { Tracer } from '../trace/tracer.js';

export interface ServeOptions {
  /** Background tasks root (discovers schedule.ts / trigger.ts). Default: 'server'. */
  dir: string;
  /** Trigger webhook port. Default: 3200. */
  port: number;
  /** Trigger endpoint prefix. Default: '/triggers'. */
  endpoint: string;
  /** Scheduler poll interval (ms). Default: 60000. */
  interval?: number;
  /** Trace store: a sqlite path or 'memory'. Default: '.anvil/traces.db'. */
  trace?: string;
  /** Bearer token required to fire triggers. Falls back to ANVIL_TRIGGER_TOKEN. */
  token?: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Build the trigger webhook fetch handler. Exported for unit tests so the
 * routing/auth logic can be exercised without binding a socket.
 */
export function buildTriggerHandler(
  triggers: TriggerRegistry,
  opts: { endpoint: string; token?: string },
): (req: Request) => Promise<Response> {
  const prefix = opts.endpoint.replace(/\/$/, '');
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (!url.pathname.startsWith(prefix + '/')) {
      return Response.json({ error: 'Not Found', status: 404 }, { status: 404 });
    }
    if (req.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    // Auth: a token is required to fire background agents.
    if (opts.token) {
      const header = req.headers.get('authorization') ?? '';
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match || !constantTimeEqual(match[1]!.trim(), opts.token)) {
        return Response.json({ error: 'Unauthorized', status: 401 }, { status: 401 });
      }
    }
    const name = decodeURIComponent(url.pathname.slice(prefix.length + 1));
    if (!triggers.has(name)) {
      return Response.json({ error: `Unknown trigger: ${name}`, status: 404 }, { status: 404 });
    }
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      payload = undefined;
    }
    const result = await triggers.fire(name, payload);
    return Response.json({ ok: true, result });
  };
}

export async function serveCommand(options: ServeOptions): Promise<void> {
  const dir = path.resolve(options.dir);
  const jiti = createJiti(import.meta.url, { interopDefault: false });
  const { schedules, triggers } = await loadBackgroundTasks(dir, (file) => jiti.import(file));

  const traceTarget = options.trace ?? '.anvil/traces.db';
  let store: MemoryTraceStore | SqliteTraceStore;
  if (traceTarget === 'memory') {
    store = new MemoryTraceStore();
  } else {
    try {
      store = await SqliteTraceStore.open(traceTarget);
    } catch {
      console.warn(`[anvil] SQLite trace store unavailable — falling back to in-memory traces.`);
      store = new MemoryTraceStore();
    }
  }
  const tracer = new Tracer(store);

  const scheduler = new Scheduler({ tracer });
  schedules.forEach((s) => scheduler.add(s));
  const stopScheduler = scheduler.start(options.interval ?? 60_000);

  const registry = new TriggerRegistry({ tracer });
  triggers.forEach((t) => registry.register(t));

  const token = options.token ?? process.env.ANVIL_TRIGGER_TOKEN;
  const handler = buildTriggerHandler(registry, { endpoint: options.endpoint, token });
  const running = await serve({ fetch: handler }, { port: options.port });

  console.log(`[anvil] background runner on http://localhost:${running.port}`);
  console.log(`[anvil] ${schedules.length} schedule(s): ${schedules.map((s) => s.name).join(', ') || 'none'}`);
  console.log(`[anvil] ${triggers.length} trigger(s): ${triggers.map((t) => t.name).join(', ') || 'none'}`);
  console.log(`[anvil] fire a trigger: POST ${options.endpoint}/<name>`);
  if (!token && triggers.length > 0) {
    console.warn('[anvil] WARNING: triggers are unauthenticated. Pass --token or set ANVIL_TRIGGER_TOKEN.');
  }

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[anvil] shutting down…');
    stopScheduler();
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

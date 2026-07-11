import { randomUUID } from 'node:crypto';
import type { AgentEvent } from '../agent/runtime.js';
import type { AgentRegistry } from '../agent/orchestrate.js';
import { MemoryStateStore, type StateStore } from '../store/index.js';

/**
 * A2A (Agent2Agent) protocol support (PRD §6.24). Exposes agent routes over
 * Google's A2A alongside MCP — one agent definition serves REST, MCP, and A2A.
 * Supports the agent card, `message/send` (sync task), `message/stream` (SSE),
 * `tasks/get`, and `tasks/cancel`. Tasks persist through a pluggable StateStore
 * so they survive restarts; protocol logic is isolated behind the transport.
 */

const PROTOCOL_VERSION = '0.3.0';
const TASK_PREFIX = 'a2a:task:';
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const DEFAULT_MAX_TASKS = 1000;

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: { streaming: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: A2ASkill[];
}

export interface A2AServerOptions {
  registry: AgentRegistry;
  name: string;
  description: string;
  url: string;
  version?: string;
  /** Skills to advertise. Each `id` must be a registered agent name. Defaults to all registered agents. */
  skills?: A2ASkill[];
  /** Agent used when a request names no skill. Defaults to the first skill. */
  defaultSkill?: string;
  /** Task store. Default: in-memory (lost on restart). Pass SqliteStateStore to persist. */
  store?: StateStore;
  /** Task retention in ms (expired on read). Default: 1h. */
  taskTtlMs?: number;
  /** Max retained tasks before oldest-eviction. Default: 1000. */
  maxTasks?: number;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';

interface Task {
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp: string };
  artifacts: Array<{ artifactId: string; parts: Array<{ kind: 'text'; text: string }> }>;
  kind: 'task';
}

interface TaskEnvelope {
  task: Task;
  updatedAt: number;
}

export class A2AServer {
  #registry: AgentRegistry;
  #options: A2AServerOptions;
  #skills: A2ASkill[];
  #defaultSkill: string;
  #store: StateStore;
  #ttlMs: number;
  #maxTasks: number;
  #running = new Map<string, AbortController>();

  constructor(options: A2AServerOptions) {
    this.#registry = options.registry;
    this.#options = options;
    this.#skills =
      options.skills ??
      options.registry.names().map((n) => ({ id: n, name: n, description: `The ${n} agent` }));
    this.#defaultSkill = options.defaultSkill ?? this.#skills[0]?.id ?? '';
    this.#store = options.store ?? new MemoryStateStore();
    this.#ttlMs = options.taskTtlMs ?? DEFAULT_TTL_MS;
    this.#maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  }

  agentCard(): AgentCard {
    return {
      protocolVersion: PROTOCOL_VERSION,
      name: this.#options.name,
      description: this.#options.description,
      url: this.#options.url,
      version: this.#options.version ?? '1.0.0',
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: this.#skills,
    };
  }

  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message.id ?? null;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return message.id == null ? null : err(id, -32600, 'Invalid request');
    }
    try {
      switch (message.method) {
        case 'message/send':
          return ok(id, await this.#messageSend(message.params));
        case 'tasks/get': {
          const taskId = (message.params as { id?: string })?.id;
          const task = taskId ? await this.#load(taskId) : undefined;
          return task ? ok(id, task) : err(id, -32001, 'Task not found');
        }
        case 'tasks/cancel':
          return await this.#tasksCancel(id, message.params);
        default:
          return err(id, -32601, `Unknown method: ${message.method}`);
      }
    } catch (e) {
      return err(id, -32603, e instanceof Error ? e.message : String(e));
    }
  }

  async #messageSend(params: unknown): Promise<Task> {
    const p = (params ?? {}) as { message?: A2AMessage; metadata?: { skillId?: string } };
    const text = extractText(p.message);
    const skill = p.metadata?.skillId ?? this.#defaultSkill;
    if (!this.#registry.has(skill)) throw new Error(`Unknown skill: ${skill}`);

    const task = this.#newTask(p.message?.contextId);
    await this.#persist(task);

    const controller = new AbortController();
    this.#running.set(task.id, controller);
    try {
      const result = await this.#registry.call(skill, text, { signal: controller.signal });
      task.status = { state: 'completed', timestamp: nowIso() };
      task.artifacts = [{ artifactId: randomUUID(), parts: [{ kind: 'text', text: result.text }] }];
    } catch (e) {
      const canceled = controller.signal.aborted;
      task.status = { state: canceled ? 'canceled' : 'failed', timestamp: nowIso() };
      task.artifacts = [
        { artifactId: randomUUID(), parts: [{ kind: 'text', text: e instanceof Error ? e.message : String(e) }] },
      ];
    } finally {
      this.#running.delete(task.id);
    }
    await this.#persist(task);
    return task;
  }

  /**
   * Stream an agent run as A2A SSE frames. Aborting `signal` (client disconnect)
   * or a `tasks/cancel` cancels the underlying run — no cost leak on a dead socket.
   */
  messageStream(id: string | number | null, params: unknown, signal?: AbortSignal): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const p = (params ?? {}) as { message?: A2AMessage; metadata?: { skillId?: string } };
    const text = extractText(p.message);
    const skill = p.metadata?.skillId ?? this.#defaultSkill;

    const controller = new AbortController();
    const combined = anySignal([signal, controller.signal]);

    return new ReadableStream<Uint8Array>({
      start: async (streamController) => {
        const send = (result: unknown) =>
          streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`));

        if (!this.#registry.has(skill)) {
          streamController.enqueue(
            encoder.encode(`data: ${JSON.stringify(err(id, -32602, `Unknown skill: ${skill}`))}\n\n`),
          );
          streamController.close();
          return;
        }

        const task = this.#newTask(p.message?.contextId);
        this.#running.set(task.id, controller);
        await this.#persist(task);
        send(task); // initial Task snapshot

        let acc = '';
        try {
          for await (const ev of this.#registry.stream(skill, text, { signal: combined })) {
            const frame = mapEvent(ev, task);
            if (frame) {
              if (ev.type === 'text') acc += ev.text;
              send(frame);
            }
          }
          task.status = { state: 'completed', timestamp: nowIso() };
          task.artifacts = [{ artifactId: randomUUID(), parts: [{ kind: 'text', text: acc }] }];
          send(statusUpdate(task, 'completed', true));
        } catch (e) {
          const canceled = combined.aborted;
          task.status = { state: canceled ? 'canceled' : 'failed', timestamp: nowIso() };
          send(statusUpdate(task, task.status.state, true, e instanceof Error ? e.message : String(e)));
        } finally {
          this.#running.delete(task.id);
          await this.#persist(task);
          streamController.close();
        }
      },
      cancel: () => {
        // Consumer released the stream (client gone) → abort the agent run.
        controller.abort();
      },
    });
  }

  async #tasksCancel(id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
    const taskId = (params as { id?: string })?.id;
    const task = taskId ? await this.#load(taskId) : undefined;
    if (!task) return err(id, -32001, 'Task not found');
    if (task.status.state === 'completed' || task.status.state === 'failed' || task.status.state === 'canceled') {
      return ok(id, task); // already terminal
    }
    this.#running.get(task.id)?.abort();
    task.status = { state: 'canceled', timestamp: nowIso() };
    await this.#persist(task);
    return ok(id, task);
  }

  #newTask(contextId?: string): Task {
    return {
      id: randomUUID(),
      contextId: contextId ?? randomUUID(),
      status: { state: 'working', timestamp: nowIso() },
      artifacts: [],
      kind: 'task',
    };
  }

  async #persist(task: Task): Promise<void> {
    const envelope: TaskEnvelope = { task, updatedAt: Date.now() };
    await Promise.resolve(this.#store.set(TASK_PREFIX + task.id, envelope));
    await this.#evict();
  }

  async #load(id: string): Promise<Task | undefined> {
    const env = await Promise.resolve(this.#store.get<TaskEnvelope>(TASK_PREFIX + id));
    if (!env) return undefined;
    if (Date.now() - env.updatedAt > this.#ttlMs) {
      await Promise.resolve(this.#store.delete(TASK_PREFIX + id));
      return undefined;
    }
    return env.task;
  }

  async #evict(): Promise<void> {
    const keys = await Promise.resolve(this.#store.list(TASK_PREFIX));
    if (keys.length <= this.#maxTasks) return;
    const envelopes: Array<{ key: string; updatedAt: number }> = [];
    for (const key of keys) {
      const env = await Promise.resolve(this.#store.get<TaskEnvelope>(key));
      envelopes.push({ key, updatedAt: env?.updatedAt ?? 0 });
    }
    envelopes.sort((a, b) => a.updatedAt - b.updatedAt);
    const excess = keys.length - this.#maxTasks;
    for (let i = 0; i < excess; i++) {
      await Promise.resolve(this.#store.delete(envelopes[i]!.key));
    }
  }
}

interface A2AMessage {
  role: string;
  parts?: Array<{ kind: string; text?: string }>;
  messageId?: string;
  contextId?: string;
}

function extractText(message: A2AMessage | undefined): string {
  return (message?.parts ?? [])
    .filter((part) => part.kind === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

/** Map an agent event to an A2A streaming frame result, or null to skip. */
function mapEvent(ev: AgentEvent, task: Task): unknown {
  if (ev.type === 'text') {
    return {
      kind: 'artifact-update',
      taskId: task.id,
      contextId: task.contextId,
      artifact: { artifactId: task.id, parts: [{ kind: 'text', text: ev.text }] },
      append: true,
      lastChunk: false,
    };
  }
  return null;
}

function statusUpdate(task: Task, state: TaskState, final: boolean, errorText?: string): unknown {
  return {
    kind: 'status-update',
    taskId: task.id,
    contextId: task.contextId,
    status: { state, timestamp: nowIso(), ...(errorText ? { message: errorText } : {}) },
    final,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Combine abort signals (Node <20.3 lacks AbortSignal.any). */
function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  const controller = new AbortController();
  for (const sig of present) {
    if (sig.aborted) {
      controller.abort();
      break;
    }
    sig.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

export interface A2AHttpOptions {
  /** JSON-RPC endpoint path. Default: '/a2a'. */
  path?: string;
  /** Agent card path. Default: '/.well-known/agent-card.json' (also serves /agent.json). */
  cardPath?: string;
}

/** A2A transport as a web-standard fetch handler — mounts into an Anvil app. */
export function a2aHttpHandler(server: A2AServer, options: A2AHttpOptions = {}): (req: Request) => Promise<Response> {
  const endpoint = options.path ?? '/a2a';
  const cardPath = options.cardPath ?? '/.well-known/agent-card.json';

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === 'GET' && (url.pathname === cardPath || url.pathname === '/.well-known/agent.json')) {
      return Response.json(server.agentCard());
    }
    if (url.pathname !== endpoint) return Response.json({ error: 'Not Found' }, { status: 404 });
    if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });

    let payload: JsonRpcRequest;
    try {
      payload = (await req.json()) as JsonRpcRequest;
    } catch {
      return Response.json(err(null, -32700, 'Parse error'));
    }

    if (payload?.method === 'message/stream') {
      const stream = server.messageStream(payload.id ?? null, payload.params, req.signal);
      return new Response(stream, {
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
      });
    }

    const response = await server.handle(payload);
    return response ? Response.json(response) : new Response(null, { status: 202 });
  };
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}
function err(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export const MODULE_STATUS = 'active' as const;

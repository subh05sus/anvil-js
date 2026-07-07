import { randomUUID } from 'node:crypto';
import type { AgentRegistry } from '../agent/orchestrate.js';

/**
 * A2A (Agent2Agent) protocol support (PRD §6.24). Exposes agent routes over
 * Google's A2A alongside MCP — one agent definition serves REST, MCP, and A2A.
 * Minimal but spec-shaped: agent card + `message/send` (synchronous task) +
 * `tasks/get`. Protocol logic is isolated behind the transport (per §11).
 */

const PROTOCOL_VERSION = '0.3.0';

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

interface Task {
  id: string;
  contextId: string;
  status: { state: 'submitted' | 'working' | 'completed' | 'failed'; timestamp: string };
  artifacts: Array<{ artifactId: string; parts: Array<{ kind: 'text'; text: string }> }>;
  kind: 'task';
}

export class A2AServer {
  #registry: AgentRegistry;
  #options: A2AServerOptions;
  #skills: A2ASkill[];
  #defaultSkill: string;
  #tasks = new Map<string, Task>();

  constructor(options: A2AServerOptions) {
    this.#registry = options.registry;
    this.#options = options;
    this.#skills =
      options.skills ??
      options.registry.names().map((n) => ({ id: n, name: n, description: `The ${n} agent` }));
    this.#defaultSkill = options.defaultSkill ?? this.#skills[0]?.id ?? '';
  }

  agentCard(): AgentCard {
    return {
      protocolVersion: PROTOCOL_VERSION,
      name: this.#options.name,
      description: this.#options.description,
      url: this.#options.url,
      version: this.#options.version ?? '0.0.1',
      capabilities: { streaming: false },
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
          const task = taskId ? this.#tasks.get(taskId) : undefined;
          return task ? ok(id, task) : err(id, -32001, 'Task not found');
        }
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

    const task: Task = {
      id: randomUUID(),
      contextId: p.message?.contextId ?? randomUUID(),
      status: { state: 'working', timestamp: new Date().toISOString() },
      artifacts: [],
      kind: 'task',
    };
    this.#tasks.set(task.id, task);

    try {
      const result = await this.#registry.call(skill, text);
      task.status = { state: 'completed', timestamp: new Date().toISOString() };
      task.artifacts = [{ artifactId: randomUUID(), parts: [{ kind: 'text', text: result.text }] }];
    } catch (e) {
      task.status = { state: 'failed', timestamp: new Date().toISOString() };
      task.artifacts = [{ artifactId: randomUUID(), parts: [{ kind: 'text', text: e instanceof Error ? e.message : String(e) }] }];
    }
    return task;
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
    .filter((p) => p.kind === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
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

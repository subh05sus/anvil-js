import type { Context } from '../kernel/context.js';
import type { ModelMessage } from '../llm/types.js';
import type { Middleware } from '../kernel/types.js';
import { runAgent, streamAgent, type AgentEvent, type AgentRunResult, type AgentTool, type RunAgentOptions } from './runtime.js';

export type AgentConfig = Omit<RunAgentOptions, 'messages'>;

/**
 * In-process registry of named agents for agent-to-agent delegation
 * (PRD §6.16). Multi-agent systems compose from the same route/tool primitives
 * rather than a separate orchestration framework.
 */
export class AgentRegistry {
  #agents = new Map<string, AgentConfig>();

  register(name: string, config: AgentConfig): this {
    this.#agents.set(name, config);
    return this;
  }

  has(name: string): boolean {
    return this.#agents.has(name);
  }

  names(): string[] {
    return [...this.#agents.keys()];
  }

  /** Invoke a registered agent with a message or full conversation. */
  async call(name: string, input: string | ModelMessage[], overrides: Partial<AgentConfig> = {}): Promise<AgentRunResult> {
    const config = this.#config(name);
    const messages: ModelMessage[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    return runAgent({ ...config, ...overrides, messages });
  }

  /**
   * Stream a registered agent's run as `AgentEvent`s (for A2A `message/stream`,
   * SSE, etc.). Pass `overrides.signal` to make cancellation abort the run.
   */
  stream(
    name: string,
    input: string | ModelMessage[],
    overrides: Partial<AgentConfig> = {},
  ): AsyncGenerator<AgentEvent, AgentRunResult> {
    const config = this.#config(name);
    const messages: ModelMessage[] = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    return streamAgent({ ...config, ...overrides, messages });
  }

  #config(name: string): AgentConfig {
    const config = this.#agents.get(name);
    if (!config) throw new Error(`No agent registered: "${name}". Registered: ${this.names().join(', ') || 'none'}`);
    return config;
  }
}

export interface AgentAsToolOptions {
  toolName?: string;
  description?: string;
  overrides?: Partial<AgentConfig>;
}

/**
 * Expose a registered agent as a tool, so an orchestrator agent can delegate to
 * it in its own loop. The sub-agent's final text becomes the tool result.
 */
export function agentAsTool(registry: AgentRegistry, name: string, options: AgentAsToolOptions = {}): AgentTool {
  return {
    name: options.toolName ?? `call_${name}`,
    description: options.description ?? `Delegate to the "${name}" agent. Provide a message describing the subtask.`,
    inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
    execute: async (input) => {
      const { message } = (input ?? {}) as { message?: string };
      const result = await registry.call(name, message ?? '', options.overrides);
      return result.text;
    },
  };
}

const AGENTS_STATE_KEY = 'agents';

/** Attach an AgentRegistry to `ctx.state.agents` for `callAgent(ctx, ...)`. */
export function withAgents(registry: AgentRegistry): Middleware {
  return async (ctx, next) => {
    ctx.state[AGENTS_STATE_KEY] = registry;
    return next();
  };
}

export function getAgents(ctx: Context): AgentRegistry | undefined {
  return ctx.state[AGENTS_STATE_KEY] as AgentRegistry | undefined;
}

/** `ctx.callAgent(...)` sugar — delegate to a named agent from within a handler. */
export function callAgent(ctx: Context, name: string, input: string | ModelMessage[]): Promise<AgentRunResult> {
  const registry = getAgents(ctx);
  if (!registry) throw new Error('No AgentRegistry available: add withAgents() middleware.');
  return registry.call(name, input);
}

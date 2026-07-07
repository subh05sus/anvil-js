import { HttpError } from '../kernel/errors.js';
import type { Context } from '../kernel/context.js';
import type { Handler, Middleware } from '../kernel/types.js';
import type { LlmClient } from '../llm/client.js';
import type { ModelMessage } from '../llm/types.js';
import { CostGovernor, type BudgetConfig } from '../trace/governor.js';
import type { Tracer, TraceHandle } from '../trace/tracer.js';
import { toDataStreamResponse } from './datastream.js';
import { streamAgent, type AgentEvent, type AgentTool } from './runtime.js';

const LLM_STATE_KEY = 'llm';

/** Middleware that attaches an LlmClient to `ctx.state.llm` for downstream agent handlers. */
export function withLlm(client: LlmClient): Middleware {
  return async (ctx, next) => {
    ctx.state[LLM_STATE_KEY] = client;
    return next();
  };
}

/** Read the LlmClient a `withLlm` middleware attached, if any. */
export function getLlm(ctx: Context): LlmClient | undefined {
  return ctx.state[LLM_STATE_KEY] as LlmClient | undefined;
}

export interface DefineAgentConfig {
  /** LlmClient to use. If omitted, resolved from `resolveClient` or `ctx.state.llm`. */
  client?: LlmClient;
  resolveClient?: (ctx: Context) => LlmClient | undefined;
  model?: string;
  system?: string | ((ctx: Context) => string | Promise<string>);
  tools?: AgentTool[] | ((ctx: Context) => AgentTool[] | Promise<AgentTool[]>);
  maxIterations?: number;
  /** Trace each run (PRD §6.6). A trace is opened per request and closed when the stream ends. */
  tracer?: Tracer;
  traceName?: string | ((ctx: Context) => string);
  /** Per-request budget cap (PRD §6.15). */
  budget?: BudgetConfig;
  /** Extract the conversation from the request. Default: `body.messages` (AI SDK chat shape). */
  getMessages?: (ctx: Context) => ModelMessage[] | Promise<ModelMessage[]>;
}

/**
 * Build an agent route handler (PRD §6.2). The default export of an `agent.ts`
 * file, or a `post.ts`. Streams the AI SDK data stream protocol and threads the
 * request's AbortSignal into the model and tool calls, so a client disconnect
 * stops the run (PRD §11 edge #3).
 */
export function defineAgent(config: DefineAgentConfig): Handler {
  return async (ctx: Context): Promise<Response> => {
    const client = config.client ?? config.resolveClient?.(ctx) ?? getLlm(ctx);
    if (!client) {
      throw new HttpError(500, 'No LlmClient available: pass one to defineAgent or add withLlm() middleware.');
    }

    const messages = config.getMessages ? await config.getMessages(ctx) : await defaultGetMessages(ctx);
    const system = typeof config.system === 'function' ? await config.system(ctx) : config.system;
    const tools = typeof config.tools === 'function' ? await config.tools(ctx) : config.tools;

    const trace = config.tracer?.start(resolveTraceName(config, ctx), { route: ctx.path, method: ctx.method });
    const governor = config.budget ? new CostGovernor(config.budget) : undefined;

    const events = streamAgent({
      client,
      model: config.model,
      system,
      messages,
      tools,
      maxIterations: config.maxIterations,
      signal: ctx.req.signal,
      trace,
      governor,
    });

    const stream = trace ? closeTraceAfter(events, trace, ctx.req.signal) : events;
    return toDataStreamResponse(stream, { signal: ctx.req.signal });
  };
}

function resolveTraceName(config: DefineAgentConfig, ctx: Context): string {
  if (typeof config.traceName === 'function') return config.traceName(ctx);
  return config.traceName ?? `agent ${ctx.path}`;
}

/** Close the trace once the event stream finishes (or errors), reflecting the final status. */
async function* closeTraceAfter(
  events: AsyncIterable<AgentEvent>,
  trace: TraceHandle,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  try {
    for await (const event of events) yield event;
    trace.end(signal?.aborted ? 'aborted' : 'ok');
  } catch (err) {
    trace.end('error');
    throw err;
  }
}

async function defaultGetMessages(ctx: Context): Promise<ModelMessage[]> {
  const body = await ctx.body<{ messages?: unknown }>();
  const raw = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(raw)) {
    throw new HttpError(400, 'Expected a JSON body with a "messages" array.');
  }
  return raw.map(normalizeMessage);
}

/** Accept the AI SDK message shape (content string or array of text parts). */
function normalizeMessage(m: unknown): ModelMessage {
  const msg = m as { role?: string; content?: unknown };
  const role = msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user';
  let content = '';
  if (typeof msg.content === 'string') {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join('');
  }
  return { role, content };
}

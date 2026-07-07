import { LlmClient } from '../llm/client.js';
import type { GenerateRequest, GenerateResult, ModelDriver, ModelMessage, StreamEvent, ToolCall } from '../llm/types.js';
import type { Span, Trace } from '../trace/types.js';
import { streamAgent, type AgentEvent, type AgentRunResult, type AgentTool } from './runtime.js';

interface RecordedResponse {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * A driver that returns recorded model responses in order (PRD §6.19). Lets a
 * captured trace be re-run locally with zero live model calls.
 */
export class ReplayDriver implements ModelDriver {
  readonly provider = 'replay';
  #queue: RecordedResponse[];

  constructor(responses: RecordedResponse[]) {
    this.#queue = [...responses];
  }

  supports(): boolean {
    return true;
  }

  async generate(_req: GenerateRequest): Promise<GenerateResult> {
    const next = this.#queue.shift();
    if (!next) throw new Error('ReplayDriver exhausted: the trace has no further model responses');
    return {
      text: next.text,
      model: 'replay',
      provider: this.provider,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      stopReason: next.toolCalls.length > 0 ? 'tool_use' : 'end_turn',
      toolCalls: next.toolCalls.length > 0 ? next.toolCalls : undefined,
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const result = await this.generate(req);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }
}

export interface Replayable {
  client: LlmClient;
  tools: AgentTool[];
  messages: ModelMessage[];
  system?: string;
  model?: string;
}

/**
 * Reconstruct a runnable agent from a captured trace: model calls are served
 * from the recorded responses, and tools are synthesized to return their
 * recorded outputs (so no live model spend and no real side effects re-fire).
 */
export function buildReplayFromTrace(trace: Trace): Replayable {
  const spans = [...trace.spans].sort((a, b) => a.startedAt - b.startedAt);
  const agent = spans.find((s) => s.kind === 'agent');

  const responses: RecordedResponse[] = spans
    .filter((s) => s.kind === 'model')
    .map((s) => {
      const r = (s.attributes.response ?? {}) as { text?: string; toolCalls?: ToolCall[] };
      return { text: r.text ?? '', toolCalls: r.toolCalls ?? [] };
    });

  // Recorded tool outputs, queued per tool name in call order.
  const outputsByTool = new Map<string, unknown[]>();
  for (const s of spans.filter((sp) => sp.kind === 'tool')) {
    const name = String(s.attributes.name ?? s.name.replace(/^tool:/, ''));
    (outputsByTool.get(name) ?? outputsByTool.set(name, []).get(name)!).push(s.attributes.output);
  }

  const tools: AgentTool[] = [...outputsByTool.entries()].map(([name, queue]) => {
    const outputs = [...queue];
    return {
      name,
      description: `replayed ${name}`,
      execute: () => (outputs.length > 0 ? outputs.shift() : `[replay: no recorded output for ${name}]`),
    };
  });

  const messages = ((agent?.attributes.input as ModelMessage[] | undefined) ?? []).map((m) => ({ ...m }));
  const system = agent?.attributes.system as string | undefined;

  return {
    client: new LlmClient({ drivers: [new ReplayDriver(responses)], defaultModel: 'replay' }),
    tools,
    messages,
    system,
    model: 'replay',
  };
}

/** Re-run a captured trace through the real agent loop with mocked model/tools. */
export function replayAgent(trace: Trace): AsyncGenerator<AgentEvent, AgentRunResult> {
  const r = buildReplayFromTrace(trace);
  return streamAgent({ client: r.client, model: r.model, system: r.system, messages: r.messages, tools: r.tools });
}

/** Convenience: replay a trace to completion, returning the reconstructed events + result. */
export async function replayToResult(trace: Trace): Promise<{ events: AgentEvent[]; result: AgentRunResult }> {
  const events: AgentEvent[] = [];
  const gen = replayAgent(trace);
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, result: next.value };
}

export type { Span };

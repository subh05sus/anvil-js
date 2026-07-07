import type { z } from 'zod';
import { zodToJsonSchema, type JsonSchema } from '../compiler/json-schema.js';
import type { LlmClient } from '../llm/client.js';
import type { ContentBlock, GenerateResult, ModelMessage, ToolCall, ToolSpec } from '../llm/types.js';
import type { CostGovernor } from '../trace/governor.js';
import type { TraceHandle } from '../trace/tracer.js';

/**
 * A tool the agent can call. `input` is validated with `zodSchema` (if given)
 * before `execute` runs. Declare `sideEffect: true` for tools that mutate
 * external state — the checkpoint-fencing hook (M5, PRD §6.20) keys off it.
 */
export interface AgentTool<Input = unknown> {
  name: string;
  description: string;
  /** JSON Schema advertised to the model. Derived from `zodSchema` if omitted. */
  inputSchema?: JsonSchema;
  zodSchema?: z.ZodType<Input>;
  sideEffect?: boolean;
  execute: (input: Input, meta: ToolExecMeta) => Promise<unknown> | unknown;
}

export interface ToolExecMeta {
  callId: string;
  signal?: AbortSignal;
}

export type AgentEvent =
  | { type: 'iteration'; n: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'final'; text: string; usage: GenerateResult['usage']; costUsd?: number; iterations: number }
  | { type: 'error'; error: string };

export interface RunAgentOptions {
  client: LlmClient;
  model?: string;
  system?: string;
  messages: ModelMessage[];
  tools?: AgentTool[];
  /** Hard cap on model↔tool turns (PRD §6.2). Default 10. */
  maxIterations?: number;
  /** Aborts model calls and tool execution (client disconnect → here). */
  signal?: AbortSignal;
  /** Trace this run — records agent/model/tool spans (PRD §6.6). */
  trace?: TraceHandle;
  /** Per-run budget cap; checked before each model call, recorded after (PRD §6.15). */
  governor?: CostGovernor;
}

export interface AgentRunResult {
  text: string;
  messages: ModelMessage[];
  iterations: number;
  totalUsage: GenerateResult['usage'];
  totalCostUsd: number;
  /** True if the loop stopped because it hit maxIterations rather than finishing. */
  stoppedAtCap: boolean;
}

class AbortedError extends Error {
  constructor() {
    super('Agent run aborted');
    this.name = 'AbortedError';
  }
}

/**
 * Drive the agent loop: call the model, execute any requested tools, feed
 * results back, repeat until the model returns a final answer or the iteration
 * cap is hit. `streamAgent` yields events live; `runAgent` collects the result.
 */
export async function* streamAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent, AgentRunResult> {
  const maxIterations = opts.maxIterations ?? 10;
  const toolMap = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const toolSpecs: ToolSpec[] = (opts.tools ?? []).map(toSpec);
  const messages: ModelMessage[] = [...opts.messages];

  const total = { inputTokens: 0, outputTokens: 0 };
  let totalCostUsd = 0;
  let finalText = '';
  let iterations = 0;
  let stoppedAtCap = false;

  const agentSpan = opts.trace?.startSpan('agent', 'agent', { model: opts.model });

  try {
    for (let i = 0; i < maxIterations; i++) {
      throwIfAborted(opts.signal);
      iterations = i + 1;
      yield { type: 'iteration', n: iterations };

      // Gate on the budget before spending (PRD §6.15).
      opts.governor?.assertWithinBudget();

      const modelSpan = opts.trace?.startSpan('model', 'model', { model: opts.model }, agentSpan?.id);
      let result: GenerateResult;
      try {
        result = await opts.client.generate({
          model: opts.model,
          system: opts.system,
          messages,
          tools: toolSpecs.length ? toolSpecs : undefined,
          signal: opts.signal,
        });
      } catch (err) {
        modelSpan?.fail(err);
        throw err;
      }
      modelSpan?.end('ok', {
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        costUsd: result.costUsd,
        stopReason: result.stopReason,
      });

      total.inputTokens += result.usage.inputTokens;
      total.outputTokens += result.usage.outputTokens;
      totalCostUsd += result.costUsd ?? 0;
      opts.governor?.record(result.usage, result.costUsd);
      opts.trace?.addUsage(result.usage, result.costUsd);

      if (result.text) yield { type: 'text', text: result.text };

      const calls = result.toolCalls ?? [];
      if (calls.length === 0) {
        finalText = result.text;
        agentSpan?.end('ok', { iterations });
        yield { type: 'final', text: finalText, usage: total, costUsd: totalCostUsd, iterations };
        return done();
      }

      // Record the assistant turn (text + tool_use blocks) before executing.
      messages.push({ role: 'assistant', content: assistantBlocks(result.text, calls) });

      const resultBlocks: ContentBlock[] = [];
      for (const call of calls) {
        throwIfAborted(opts.signal);
        yield { type: 'tool_call', id: call.id, name: call.name, input: call.input };
        const toolSpan = opts.trace?.startSpan(`tool:${call.name}`, 'tool', { name: call.name, input: call.input }, agentSpan?.id);
        const { output, isError } = await runTool(toolMap, call, opts.signal);
        toolSpan?.end(isError ? 'error' : 'ok', { output });
        yield { type: 'tool_result', id: call.id, name: call.name, output, isError };
        resultBlocks.push({
          type: 'tool_result',
          toolUseId: call.id,
          content: typeof output === 'string' ? output : JSON.stringify(output),
          isError,
        });
      }
      messages.push({ role: 'user', content: resultBlocks });
    }

    // Cap reached with tools still pending.
    stoppedAtCap = true;
    agentSpan?.end('ok', { iterations, stoppedAtCap: true });
    yield { type: 'final', text: finalText, usage: total, costUsd: totalCostUsd, iterations };
    return done();
  } catch (err) {
    agentSpan?.fail(err);
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) };
    throw err;
  }

  function done(): AgentRunResult {
    return { text: finalText, messages, iterations, totalUsage: total, totalCostUsd, stoppedAtCap };
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const gen = streamAgent(opts);
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

async function runTool(
  toolMap: Map<string, AgentTool>,
  call: ToolCall,
  signal?: AbortSignal,
): Promise<{ output: unknown; isError: boolean }> {
  const tool = toolMap.get(call.name);
  if (!tool) return { output: `Unknown tool: ${call.name}`, isError: true };
  let input = call.input;
  if (tool.zodSchema) {
    const parsed = tool.zodSchema.safeParse(call.input);
    if (!parsed.success) return { output: `Invalid tool input: ${parsed.error.message}`, isError: true };
    input = parsed.data;
  }
  try {
    const output = await tool.execute(input, { callId: call.id, signal });
    return { output, isError: false };
  } catch (err) {
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function toSpec(tool: AgentTool): ToolSpec {
  const inputSchema =
    tool.inputSchema ?? (tool.zodSchema ? zodToJsonSchema(tool.zodSchema as never) : { type: 'object', properties: {} });
  return { name: tool.name, description: tool.description, inputSchema };
}

function assistantBlocks(text: string, calls: ToolCall[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const c of calls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
  return blocks;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortedError();
}

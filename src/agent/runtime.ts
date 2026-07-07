import type { z } from 'zod';
import { zodToJsonSchema, type JsonSchema } from '../compiler/json-schema.js';
import type { LlmClient } from '../llm/client.js';
import type { ContentBlock, GenerateResult, ModelMessage, ToolCall, ToolSpec } from '../llm/types.js';
import type { CostGovernor } from '../trace/governor.js';
import type { TraceHandle, SpanHandle } from '../trace/tracer.js';
import type { StateStore } from '../store/index.js';
import { ApprovalRequiredError, Checkpointer, type AgentCheckpoint } from './durable.js';
import { applyTextGuards, decideToolCall, type Guardrail } from './guardrails.js';

/**
 * A tool the agent can call. `input` is validated with `zodSchema` (if given)
 * before `execute` runs. Declare `sideEffect: true` for tools that mutate
 * external state — the checkpoint fence records completed calls so a resume
 * never re-runs them (PRD §6.20).
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
  /** Suspend the run for human approval (PRD §6.7). Throws; resume with `resumeAgent`. */
  requestApproval: (payload?: unknown) => never;
}

export type AgentEvent =
  | { type: 'iteration'; n: number }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; output: unknown; isError: boolean }
  | { type: 'suspended'; runId?: string; callId: string; payload: unknown }
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
  /** Durable checkpointing (PRD §6.20). Persist a checkpoint after each step. */
  checkpoint?: { store: StateStore; runId: string };
  /**
   * Pre-supplied tool results keyed by call id — used on resume to fence
   * already-executed side-effect calls and to inject a granted approval. Any
   * call whose id is present here is NOT re-executed.
   */
  approvals?: Record<string, unknown>;
  /** Seed counters when resuming from a checkpoint. */
  resumeState?: { iterations: number; totalUsage: GenerateResult['usage']; totalCostUsd: number };
  /** Policy layer (PRD §6.14, §6.21): filters output text and gates tool calls. */
  guardrails?: Guardrail[];
}

export interface AgentRunResult {
  text: string;
  messages: ModelMessage[];
  iterations: number;
  totalUsage: GenerateResult['usage'];
  totalCostUsd: number;
  /** True if the loop stopped at maxIterations rather than finishing. */
  stoppedAtCap: boolean;
  /** Set when the run suspended for human approval. */
  suspended?: { runId?: string; callId: string; payload: unknown };
}

class AbortedError extends Error {
  constructor() {
    super('Agent run aborted');
    this.name = 'AbortedError';
  }
}

interface ExecContext {
  toolMap: Map<string, AgentTool>;
  approvals: Record<string, unknown>;
  signal?: AbortSignal;
  trace?: TraceHandle;
  agentSpanId?: string;
  guardrails: Guardrail[];
  /** Untrusted (tool/retrieved) content already in context — drives injection policy. */
  tainted: boolean;
}

type ExecOutcome =
  | { kind: 'done'; resultBlocks: ContentBlock[] }
  | { kind: 'suspended'; callId: string; payload: unknown; completed: Record<string, unknown> };

/**
 * Drive the agent loop: call the model, execute requested tools, feed results
 * back, repeat until a final answer or the iteration cap. Supports durable
 * checkpointing and human-in-the-loop suspension. `streamAgent` yields events;
 * `runAgent` collects the result.
 */
export async function* streamAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent, AgentRunResult> {
  const maxIterations = opts.maxIterations ?? 10;
  const toolMap = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const toolSpecs: ToolSpec[] = (opts.tools ?? []).map(toSpec);
  const messages: ModelMessage[] = [...opts.messages];
  const approvals = opts.approvals ?? {};
  const checkpointer = opts.checkpoint ? new Checkpointer(opts.checkpoint.store, opts.checkpoint.runId) : undefined;

  const total = { ...(opts.resumeState?.totalUsage ?? { inputTokens: 0, outputTokens: 0 }) };
  let totalCostUsd = opts.resumeState?.totalCostUsd ?? 0;
  let finalText = '';
  let iterations = opts.resumeState?.iterations ?? 0;
  let stoppedAtCap = false;

  const guardrails = opts.guardrails ?? [];
  const agentSpan = opts.trace?.startSpan('agent', 'agent', { model: opts.model });
  // Tainted once any tool result is already in the conversation (resume-safe).
  const ctx: ExecContext = {
    toolMap,
    approvals,
    signal: opts.signal,
    trace: opts.trace,
    agentSpanId: agentSpan?.id,
    guardrails,
    tainted: hasToolResults(messages),
  };

  const saveCheckpoint = async (status: AgentCheckpoint['status'], extra: Partial<AgentCheckpoint> = {}) => {
    await checkpointer?.save({ status, messages, iterations, totalUsage: total, totalCostUsd, ...extra });
  };

  try {
    // Resume path: settle tool calls left outstanding by a suspended checkpoint
    // (the trailing assistant tool_use turn has no answering user results yet).
    const outstanding = outstandingToolCalls(messages);
    if (outstanding.length > 0) {
      const outcome = yield* executeCalls(outstanding, ctx);
      if (outcome.kind === 'suspended') {
        return yield* suspend(outcome);
      }
      messages.push({ role: 'user', content: outcome.resultBlocks });
      ctx.tainted = true; // tool output is untrusted from here on
      await saveCheckpoint('running');
    }

    for (let i = iterations; i < maxIterations; i++) {
      throwIfAborted(opts.signal);
      iterations = i + 1;
      yield { type: 'iteration', n: iterations };

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

      const text = guardrails.length ? applyTextGuards(result.text, 'output', guardrails) : result.text;
      if (text) yield { type: 'text', text };

      const calls = result.toolCalls ?? [];
      if (calls.length === 0) {
        finalText = text;
        agentSpan?.end('ok', { iterations });
        await saveCheckpoint('done', { finalText });
        yield { type: 'final', text: finalText, usage: total, costUsd: totalCostUsd, iterations };
        return done();
      }

      messages.push({ role: 'assistant', content: assistantBlocks(text, calls) });

      const outcome = yield* executeCalls(calls, ctx);
      if (outcome.kind === 'suspended') {
        return yield* suspend(outcome);
      }
      messages.push({ role: 'user', content: outcome.resultBlocks });
      ctx.tainted = true;
      await saveCheckpoint('running');
    }

    stoppedAtCap = true;
    agentSpan?.end('ok', { iterations, stoppedAtCap: true });
    await saveCheckpoint('done');
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

  // Persist a suspended checkpoint and emit the suspended event.
  async function* suspend(outcome: Extract<ExecOutcome, { kind: 'suspended' }>): AsyncGenerator<AgentEvent, AgentRunResult> {
    agentSpan?.end('ok', { suspended: true });
    // completed results become approvals so a resume fences them (no re-run).
    await saveCheckpoint('suspended', {
      approvals: { ...approvals, ...outcome.completed },
      pending: { callId: outcome.callId, payload: outcome.payload },
    });
    yield { type: 'suspended', runId: opts.checkpoint?.runId, callId: outcome.callId, payload: outcome.payload };
    return { ...done(), suspended: { runId: opts.checkpoint?.runId, callId: outcome.callId, payload: outcome.payload } };
  }
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const gen = streamAgent(opts);
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

/**
 * Resume a suspended or crashed run from its checkpoint (PRD §6.20, §6.7).
 * Pass `approval` to inject the decision for a HITL-suspended run. Already-run
 * tool calls are fenced by the checkpoint's `approvals` map.
 */
export async function* resumeAgent(
  opts: Omit<RunAgentOptions, 'messages' | 'approvals' | 'resumeState'> & {
    checkpoint: { store: StateStore; runId: string };
    approval?: unknown;
  },
): AsyncGenerator<AgentEvent, AgentRunResult> {
  const checkpointer = new Checkpointer(opts.checkpoint.store, opts.checkpoint.runId);
  const cp = await checkpointer.load();
  if (!cp) throw new Error(`No checkpoint for run "${opts.checkpoint.runId}"`);
  if (cp.status === 'done') {
    return { text: cp.finalText ?? '', messages: cp.messages, iterations: cp.iterations, totalUsage: cp.totalUsage, totalCostUsd: cp.totalCostUsd, stoppedAtCap: false };
  }

  const approvals = { ...(cp.approvals ?? {}) };
  if (cp.pending) approvals[cp.pending.callId] = opts.approval;

  return yield* streamAgent({
    ...opts,
    messages: cp.messages,
    approvals,
    resumeState: { iterations: cp.iterations, totalUsage: cp.totalUsage, totalCostUsd: cp.totalCostUsd },
  });
}

/** Run a batch of tool calls, honoring pre-supplied results and suspension. */
async function* executeCalls(calls: ToolCall[], ctx: ExecContext): AsyncGenerator<AgentEvent, ExecOutcome> {
  const resultBlocks: ContentBlock[] = [];
  const completed: Record<string, unknown> = {};

  for (const call of calls) {
    throwIfAborted(ctx.signal);
    yield { type: 'tool_call', id: call.id, name: call.name, input: call.input };
    const span: SpanHandle | undefined = ctx.trace?.startSpan(`tool:${call.name}`, 'tool', { name: call.name, input: call.input }, ctx.agentSpanId);

    // Fenced/approved: result was supplied (resume) — do not re-execute or re-gate.
    if (Object.prototype.hasOwnProperty.call(ctx.approvals, call.id)) {
      const output = ctx.approvals[call.id];
      span?.end('ok', { output, fenced: true });
      yield { type: 'tool_result', id: call.id, name: call.name, output, isError: false };
      resultBlocks.push(toResultBlock(call.id, output, false));
      completed[call.id] = output;
      continue;
    }

    // Policy gate (PRD §6.14, §6.21): deny → error result; approve → suspend for HITL.
    if (ctx.guardrails.length > 0) {
      const decision = decideToolCall({ name: call.name, input: call.input, tainted: ctx.tainted }, ctx.guardrails);
      if (decision.action === 'deny') {
        const output = `Tool blocked by guardrail: ${decision.reason ?? 'denied'}`;
        span?.end('error', { output, blocked: true });
        yield { type: 'tool_result', id: call.id, name: call.name, output, isError: true };
        resultBlocks.push(toResultBlock(call.id, output, true));
        completed[call.id] = output;
        continue;
      }
      if (decision.action === 'approve') {
        span?.end('ok', { suspended: true });
        return { kind: 'suspended', callId: call.id, payload: { guardrail: decision.reason, name: call.name, input: call.input }, completed };
      }
    }

    try {
      const { output, isError } = await runTool(ctx.toolMap, call, ctx.signal);
      span?.end(isError ? 'error' : 'ok', { output });
      yield { type: 'tool_result', id: call.id, name: call.name, output, isError };
      resultBlocks.push(toResultBlock(call.id, output, isError));
      completed[call.id] = output;
    } catch (err) {
      if (err instanceof ApprovalRequiredError) {
        span?.end('ok', { suspended: true });
        return { kind: 'suspended', callId: err.callId, payload: err.payload, completed };
      }
      throw err;
    }
  }
  return { kind: 'done', resultBlocks };
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
  const meta: ToolExecMeta = {
    callId: call.id,
    signal,
    requestApproval: (payload?: unknown) => {
      throw new ApprovalRequiredError(call.id, payload);
    },
  };
  try {
    const output = await tool.execute(input, meta);
    return { output, isError: false };
  } catch (err) {
    if (err instanceof ApprovalRequiredError) throw err; // handled by the loop, not a tool error
    return { output: err instanceof Error ? err.message : String(err), isError: true };
  }
}

function toResultBlock(callId: string, output: unknown, isError: boolean): ContentBlock {
  return { type: 'tool_result', toolUseId: callId, content: typeof output === 'string' ? output : JSON.stringify(output), isError };
}

/** Whether any tool_result block appears in the conversation (→ tainted context). */
function hasToolResults(messages: ModelMessage[]): boolean {
  return messages.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'));
}

/** Tool calls in the trailing assistant turn that have no answering tool_result yet. */
function outstandingToolCalls(messages: ModelMessage[]): ToolCall[] {
  const last = messages.at(-1);
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return [];
  return last.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));
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

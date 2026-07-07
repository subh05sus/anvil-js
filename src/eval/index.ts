import type { z } from 'zod';
import type { LlmClient } from '../llm/client.js';
import type { ModelMessage } from '../llm/types.js';
import { runAgent, type AgentEvent, type AgentRunResult, type AgentTool } from '../agent/runtime.js';

/** What an assertion sees: the final text plus the full recorded run. */
export interface EvalRunContext {
  text: string;
  events: AgentEvent[];
  result: AgentRunResult;
  toolCalls: Array<{ id: string; name: string; input: unknown }>;
  latencyMs: number;
}

export interface AssertionResult {
  pass: boolean;
  message?: string;
}

export interface Assertion {
  name: string;
  check: (ctx: EvalRunContext) => AssertionResult | Promise<AssertionResult>;
}

export interface EvalCase {
  name: string;
  input: string | ModelMessage[];
  assert: Assertion[];
}

/** A runner turns a case's messages into a recorded run. */
export type EvalRunner = (messages: ModelMessage[]) => Promise<EvalRunContext>;

export interface EvalSuite {
  name: string;
  runner: EvalRunner;
  cases: EvalCase[];
}

export interface CaseReport {
  name: string;
  pass: boolean;
  assertions: Array<{ name: string; pass: boolean; message?: string }>;
  error?: string;
}

export interface EvalReport {
  suite: string;
  cases: CaseReport[];
  passed: number;
  failed: number;
}

export function defineEvalSuite(suite: EvalSuite): EvalSuite {
  return suite;
}

/** Build a runner from an agent config (PRD §6.12). Records events, tool calls, and latency. */
export function agentRunner(base: Omit<Parameters<typeof runAgent>[0], 'messages'> & { client: LlmClient; tools?: AgentTool[] }): EvalRunner {
  return async (messages) => {
    const events: AgentEvent[] = [];
    const started = Date.now();
    const gen = (await import('../agent/runtime.js')).streamAgent({ ...base, messages });
    let next = await gen.next();
    while (!next.done) {
      events.push(next.value);
      next = await gen.next();
    }
    const result = next.value;
    return {
      text: result.text,
      events,
      result,
      toolCalls: events.filter((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call'),
      latencyMs: Date.now() - started,
    };
  };
}

/** Run every case's assertions and produce a pass/fail report. */
export async function runSuite(suite: EvalSuite): Promise<EvalReport> {
  const cases: CaseReport[] = [];
  for (const c of suite.cases) {
    const messages: ModelMessage[] = typeof c.input === 'string' ? [{ role: 'user', content: c.input }] : c.input;
    try {
      const ctx = await suite.runner(messages);
      const assertions = [];
      for (const a of c.assert) {
        const r = await a.check(ctx);
        assertions.push({ name: a.name, pass: r.pass, message: r.message });
      }
      cases.push({ name: c.name, pass: assertions.every((a) => a.pass), assertions });
    } catch (err) {
      cases.push({ name: c.name, pass: false, assertions: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  const passed = cases.filter((c) => c.pass).length;
  return { suite: suite.name, cases, passed, failed: cases.length - passed };
}

// ── Deterministic assertions ────────────────────────────────────────

export function outputContains(substring: string): Assertion {
  return {
    name: `output contains "${substring}"`,
    check: (ctx) => ({ pass: ctx.text.includes(substring), message: ctx.text.includes(substring) ? undefined : `got: ${ctx.text.slice(0, 120)}` }),
  };
}

export function outputMatches(re: RegExp): Assertion {
  return { name: `output matches ${re}`, check: (ctx) => ({ pass: re.test(ctx.text), message: re.test(ctx.text) ? undefined : `got: ${ctx.text.slice(0, 120)}` }) };
}

export function toolCalled(name: string): Assertion {
  return {
    name: `tool "${name}" called`,
    check: (ctx) => {
      const called = ctx.toolCalls.some((t) => t.name === name);
      return { pass: called, message: called ? undefined : `tools called: ${ctx.toolCalls.map((t) => t.name).join(', ') || 'none'}` };
    },
  };
}

export function maxCost(usd: number): Assertion {
  return {
    name: `cost ≤ $${usd}`,
    check: (ctx) => ({ pass: ctx.result.totalCostUsd <= usd, message: `spent $${ctx.result.totalCostUsd.toFixed(4)}` }),
  };
}

export function maxIterations(n: number): Assertion {
  return { name: `≤ ${n} iterations`, check: (ctx) => ({ pass: ctx.result.iterations <= n, message: `used ${ctx.result.iterations}` }) };
}

export function outputJson<T>(schema: z.ZodType<T>): Assertion {
  return {
    name: 'output is schema-valid JSON',
    check: (ctx) => {
      try {
        const parsed = schema.safeParse(JSON.parse(ctx.text));
        return { pass: parsed.success, message: parsed.success ? undefined : parsed.error.message };
      } catch (err) {
        return { pass: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

// ── LLM-as-judge assertion (PRD §6.12) ──────────────────────────────

export interface JudgeOptions {
  client: LlmClient;
  rubric: string;
  model?: string;
}

/**
 * Score the agent's output against a rubric using a model. The judge call runs
 * through the same LlmClient — so it's traced and cost-tracked like any other.
 */
export function judge(options: JudgeOptions): Assertion {
  return {
    name: `judge: ${options.rubric.slice(0, 60)}`,
    check: async (ctx) => {
      const result = await options.client.generate({
        model: options.model,
        system: 'You are a strict evaluator. Reply with a single JSON object {"pass": boolean, "reason": string}. No prose.',
        messages: [{ role: 'user', content: `Rubric:\n${options.rubric}\n\nOutput to judge:\n${ctx.text}` }],
      });
      try {
        const verdict = JSON.parse(stripFences(result.text)) as { pass?: unknown; reason?: unknown };
        return { pass: verdict.pass === true, message: typeof verdict.reason === 'string' ? verdict.reason : undefined };
      } catch {
        return { pass: false, message: `judge returned non-JSON: ${result.text.slice(0, 120)}` };
      }
    },
  };
}

function stripFences(text: string): string {
  const m = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1]! : text.trim();
}

export const MODULE_STATUS = 'active' as const;

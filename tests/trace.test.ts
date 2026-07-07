import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver } from '../src/llm/drivers/mock.js';
import { runAgent, type AgentTool } from '../src/agent/runtime.js';
import { MemoryTraceStore } from '../src/trace/memory-store.js';
import { Tracer } from '../src/trace/tracer.js';
import { CostGovernor, BudgetExceededError } from '../src/trace/governor.js';
import type { MockDriverOptions } from '../src/llm/drivers/mock.js';

const clientWith = (options: Omit<MockDriverOptions, 'prefix'>) => {
  const driver = new MockDriver({ prefix: 'claude', ...options });
  return new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
};

describe('MemoryTraceStore', () => {
  it('stores and retrieves traces newest-first', () => {
    const store = new MemoryTraceStore();
    store.saveTrace({ id: 'a', name: 'a', startedAt: 1, status: 'ok', spans: [], totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, attributes: {} });
    store.saveTrace({ id: 'b', name: 'b', startedAt: 2, status: 'ok', spans: [], totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, attributes: {} });
    expect(store.listTraces().map((t) => t.id)).toEqual(['b', 'a']);
    expect(store.getTrace('a')?.name).toBe('a');
  });
});

describe('Tracer', () => {
  it('builds a span tree and persists it on end', () => {
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store);
    const trace = tracer.start('run', { route: '/chat' });
    const parent = trace.startSpan('agent', 'agent');
    const child = trace.startSpan('model', 'model', {}, parent.id);
    child.end('ok', { usage: { inputTokens: 3, outputTokens: 1 } });
    trace.addUsage({ inputTokens: 3, outputTokens: 1 }, 0.01);
    parent.end('ok');
    const finished = trace.end('ok');

    expect(finished.status).toBe('ok');
    expect(finished.endedAt).toBeGreaterThanOrEqual(finished.startedAt);
    expect(finished.totalCostUsd).toBe(0.01);

    const stored = store.getTrace(trace.id)!;
    expect(stored.spans).toHaveLength(2);
    const modelSpan = stored.spans.find((s) => s.name === 'model')!;
    expect(modelSpan.parentId).toBe(parent.id);
    expect(modelSpan.status).toBe('ok');
  });

  it('marks a failed span with the error message', () => {
    const store = new MemoryTraceStore();
    const trace = new Tracer(store).start('run');
    const span = trace.startSpan('model', 'model');
    span.fail(new Error('boom'));
    trace.end('error');
    const stored = store.getTrace(trace.id)!;
    expect(stored.spans[0]!.status).toBe('error');
    expect(stored.spans[0]!.error).toBe('boom');
  });

  it('calls onExport with the finished trace', () => {
    const store = new MemoryTraceStore();
    let exported = '';
    const trace = new Tracer(store, { onExport: (t) => (exported = t.id) }).start('run');
    trace.end('ok');
    expect(exported).toBe(trace.id);
  });
});

describe('CostGovernor', () => {
  it('accumulates spend and blocks once over the USD cap', () => {
    const gov = new CostGovernor({ maxUsd: 0.05 });
    expect(gov.assertWithinBudget()).toBe('ok');
    gov.record({ inputTokens: 100, outputTokens: 100 }, 0.06);
    expect(gov.spentUsd).toBeCloseTo(0.06);
    expect(() => gov.assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it('blocks on the token cap', () => {
    const gov = new CostGovernor({ maxTokens: 50 });
    gov.record({ inputTokens: 40, outputTokens: 20 }, 0);
    expect(() => gov.assertWithinBudget()).toThrow(BudgetExceededError);
  });

  it('surfaces degrade/approve via onBreach instead of throwing', () => {
    const seen: string[] = [];
    const gov = new CostGovernor({ maxUsd: 0.01, onBreach: 'degrade' }, (i) => seen.push(i.action));
    gov.record({ inputTokens: 0, outputTokens: 0 }, 0.02);
    expect(gov.assertWithinBudget()).toBe('degrade');
    expect(seen).toEqual(['degrade']);
  });
});

const weatherTool = (): AgentTool => ({
  name: 'get_weather',
  description: 'weather',
  zodSchema: z.object({ city: z.string() }),
  execute: () => ({ tempC: 21 }),
});

describe('agent runtime with tracing', () => {
  it('records agent, model, and tool spans in one trace', async () => {
    const store = new MemoryTraceStore();
    const trace = new Tracer(store).start('chat');
    const client = clientWith({
      script: [
        { text: '', toolCalls: [{ id: 't1', name: 'get_weather', input: { city: 'Paris' } }], usage: { inputTokens: 50, outputTokens: 5 } },
        { text: 'It is 21C.', usage: { inputTokens: 60, outputTokens: 4 } },
      ],
    });
    await runAgent({ client, messages: [{ role: 'user', content: 'weather?' }], tools: [weatherTool()], trace });
    trace.end('ok');

    const stored = store.getTrace(trace.id)!;
    const kinds = stored.spans.map((s) => s.kind).sort();
    expect(kinds).toEqual(['agent', 'model', 'model', 'tool']);
    expect(stored.totalInputTokens).toBe(110);
    expect(stored.totalOutputTokens).toBe(9);
    const tool = stored.spans.find((s) => s.kind === 'tool')!;
    expect(tool.name).toBe('tool:get_weather');
    expect(tool.status).toBe('ok');
  });

  it('halts the run when the governor budget is exceeded', async () => {
    const client = clientWith({ defaultText: 'x', script: [{ text: 'x', usage: { inputTokens: 1000, outputTokens: 1000 } }] });
    const governor = new CostGovernor({ maxTokens: 100 });
    governor.record({ inputTokens: 200, outputTokens: 0 }, 0); // pretend prior spend
    await expect(
      runAgent({ client, messages: [{ role: 'user', content: 'x' }], governor }),
    ).rejects.toThrow(BudgetExceededError);
  });

  it('records spend into the governor as it goes', async () => {
    const client = clientWith({ script: [{ text: 'done', usage: { inputTokens: 30, outputTokens: 10 } }] });
    const governor = new CostGovernor({ maxTokens: 1000 });
    await runAgent({ client, messages: [{ role: 'user', content: 'x' }], governor });
    expect(governor.spentTokens).toBe(40);
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver, type MockDriverOptions } from '../src/llm/drivers/mock.js';
import { runAgent, type AgentTool } from '../src/agent/runtime.js';
import { buildReplayFromTrace, replayToResult } from '../src/agent/replay.js';
import { MemoryTraceStore } from '../src/trace/memory-store.js';
import { Tracer } from '../src/trace/tracer.js';

const client = (options: Omit<MockDriverOptions, 'prefix'>) =>
  new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', ...options })], defaultModel: 'claude-opus-4-8' });

async function captureTrace() {
  const store = new MemoryTraceStore();
  const trace = new Tracer(store).start('chat /support');
  const sideEffects: string[] = [];
  const lookup: AgentTool = {
    name: 'lookup_order',
    description: 'look up an order',
    zodSchema: z.object({ id: z.string() }),
    sideEffect: true,
    execute: (input) => {
      const { id } = input as { id: string };
      sideEffects.push(id);
      return { id, status: 'shipped' };
    },
  };
  const c = client({
    script: [
      { text: 'Let me check.', toolCalls: [{ id: 'c1', name: 'lookup_order', input: { id: 'A-1' } }] },
      { text: 'Your order A-1 has shipped.' },
    ],
  });
  await runAgent({ client: c, system: 'You are support.', messages: [{ role: 'user', content: 'where is order A-1?' }], tools: [lookup], trace });
  trace.end('ok');
  return { trace: store.getTrace(trace.id)!, sideEffects };
}

describe('replay', () => {
  it('reconstructs model + tool inputs from a trace', async () => {
    const { trace } = await captureTrace();
    const r = buildReplayFromTrace(trace);
    expect(r.system).toBe('You are support.');
    expect(r.messages).toEqual([{ role: 'user', content: 'where is order A-1?' }]);
    expect(r.tools.map((t) => t.name)).toEqual(['lookup_order']);
  });

  it('re-runs the loop with mocked model responses and no live model calls', async () => {
    const { trace } = await captureTrace();
    const { events, result } = await replayToResult(trace);
    expect(result.text).toBe('Your order A-1 has shipped.');
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall && toolCall.type === 'tool_call' && toolCall.name).toBe('lookup_order');
    expect(toolCall && toolCall.type === 'tool_call' && toolCall.input).toEqual({ id: 'A-1' });
    expect(result.iterations).toBe(2);
  });

  it('does not re-fire real side effects — synth tools return recorded outputs', async () => {
    const { trace, sideEffects } = await captureTrace();
    expect(sideEffects).toEqual(['A-1']); // from the original run
    const { events } = await replayToResult(trace);
    // The original tool is not used in replay; its side-effect log is unchanged.
    expect(sideEffects).toEqual(['A-1']);
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.output).toEqual({ id: 'A-1', status: 'shipped' });
  });
});

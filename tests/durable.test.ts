import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver, type MockDriverOptions } from '../src/llm/drivers/mock.js';
import { runAgent, resumeAgent, streamAgent, type AgentRunResult, type AgentTool } from '../src/agent/runtime.js';
import { Checkpointer } from '../src/agent/durable.js';
import { MemoryStateStore } from '../src/store/index.js';

const client = (options: Omit<MockDriverOptions, 'prefix'>) =>
  new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', ...options })], defaultModel: 'claude-opus-4-8' });

describe('MemoryStateStore', () => {
  it('gets/sets/deletes and lists by prefix, isolating stored values', () => {
    const s = new MemoryStateStore();
    const obj = { n: 1 };
    s.set('a:1', obj);
    obj.n = 2; // mutating the source must not affect the store (cloned on set)
    expect(s.get<{ n: number }>('a:1')).toEqual({ n: 1 });
    s.set('a:2', 'x');
    s.set('b:1', 'y');
    expect(s.list('a:').sort()).toEqual(['a:1', 'a:2']);
    s.delete('a:1');
    expect(s.get('a:1')).toBeUndefined();
  });
});

describe('durable checkpointing', () => {
  it('writes a checkpoint after each iteration and marks done at the end', async () => {
    const store = new MemoryStateStore();
    const c = client({ script: [{ text: '', toolCalls: [{ id: 't1', name: 'noop', input: {} }] }, { text: 'final' }] });
    const noop: AgentTool = { name: 'noop', description: 'noop', execute: () => 'ok' };
    await runAgent({ client: c, messages: [{ role: 'user', content: 'go' }], tools: [noop], checkpoint: { store, runId: 'r1' } });

    const cp = await new Checkpointer(store, 'r1').load();
    expect(cp?.status).toBe('done');
    expect(cp?.finalText).toBe('final');
    expect(cp?.iterations).toBe(2);
  });

  it('resumes after a crash without re-running a side-effect tool', async () => {
    const store = new MemoryStateStore();
    const runs: string[] = [];
    const chargeCard: AgentTool = {
      name: 'charge_card',
      description: 'charge',
      sideEffect: true,
      execute: () => {
        runs.push('charged');
        return { ok: true };
      },
    };

    // First run: model asks for the tool, tool runs (side effect), then we
    // simulate a crash right after the iteration checkpoint by throwing on the
    // *second* model call.
    const crashy = client({
      script: [
        { text: '', toolCalls: [{ id: 'call-1', name: 'charge_card', input: {} }] },
        { text: '', error: Object.assign(new Error('crash'), {}) },
      ],
    });
    await expect(
      runAgent({ client: crashy, messages: [{ role: 'user', content: 'pay' }], tools: [chargeCard], checkpoint: { store, runId: 'pay-1' } }),
    ).rejects.toThrow('crash');
    expect(runs).toEqual(['charged']); // charged once

    const cp = await new Checkpointer(store, 'pay-1').load();
    expect(cp?.status).toBe('running');
    // The tool result is durable in the checkpoint messages → fenced on resume.

    // Resume with a healthy client that just finishes.
    const healthy = client({ defaultText: 'Payment complete.' });
    const result = await collect(
      resumeAgent({ client: healthy, tools: [chargeCard], checkpoint: { store, runId: 'pay-1' } }),
    );
    expect(result.text).toBe('Payment complete.');
    expect(runs).toEqual(['charged']); // NOT charged again
  });
});

describe('human-in-the-loop', () => {
  const refundTool = (executed: string[]): AgentTool => ({
    name: 'refund',
    description: 'Issue a refund (needs approval)',
    zodSchema: z.object({ orderId: z.string() }),
    sideEffect: true,
    execute: (input, meta) => {
      const { orderId } = input as { orderId: string };
      // Gate the side effect on human approval.
      meta.requestApproval({ action: 'refund', orderId });
      executed.push(orderId); // unreachable until resumed
      return { refunded: orderId };
    },
  });

  it('suspends the run when a tool requests approval', async () => {
    const store = new MemoryStateStore();
    const executed: string[] = [];
    const c = client({ script: [{ text: '', toolCalls: [{ id: 'r1', name: 'refund', input: { orderId: 'A' } }] }] });
    const result = await collect(
      streamAgent({ client: c, messages: [{ role: 'user', content: 'refund A' }], tools: [refundTool(executed)], checkpoint: { store, runId: 'ref-1' } }),
    );
    expect(result.suspended?.callId).toBe('r1');
    expect(result.suspended?.payload).toMatchObject({ action: 'refund', orderId: 'A' });
    expect(executed).toEqual([]); // side effect not performed

    const cp = await new Checkpointer(store, 'ref-1').load();
    expect(cp?.status).toBe('suspended');
    expect(cp?.pending?.callId).toBe('r1');
  });

  it('resumes with an approval decision and injects it as the tool result', async () => {
    const store = new MemoryStateStore();
    const executed: string[] = [];
    const c = client({ script: [{ text: '', toolCalls: [{ id: 'r1', name: 'refund', input: { orderId: 'A' } }] }] });
    await collect(streamAgent({ client: c, messages: [{ role: 'user', content: 'refund A' }], tools: [refundTool(executed)], checkpoint: { store, runId: 'ref-2' } }));

    // Human approved → resume. The approved result is injected; the tool's own
    // execute() is NOT re-run (so no double refund), and the model finishes.
    const healthy = client({ defaultText: 'Refund issued.' });
    const result = await collect(
      resumeAgent({ client: healthy, tools: [refundTool(executed)], checkpoint: { store, runId: 'ref-2' }, approval: { approved: true, refunded: 'A' } }),
    );
    expect(result.text).toBe('Refund issued.');
    expect(executed).toEqual([]); // execute() never re-ran; approval result used
    const doneCp = await new Checkpointer(store, 'ref-2').load();
    expect(doneCp?.status).toBe('done');
  });
});

// Helpers ------------------------------------------------------------

async function collect(gen: AsyncGenerator<unknown, AgentRunResult>): Promise<AgentRunResult> {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

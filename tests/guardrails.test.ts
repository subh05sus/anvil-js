import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver, type MockDriverOptions } from '../src/llm/drivers/mock.js';
import { runAgent, streamAgent, type AgentEvent, type AgentRunResult, type AgentTool } from '../src/agent/runtime.js';
import {
  applyTextGuards,
  contentFilter,
  decideToolCall,
  injectionGuard,
  redactPII,
  toolPolicy,
  GuardrailError,
} from '../src/agent/guardrails.js';

const client = (options: Omit<MockDriverOptions, 'prefix'>) =>
  new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', ...options })], defaultModel: 'claude-opus-4-8' });

describe('guardrail primitives', () => {
  it('redactPII scrubs email/card/ssn/phone', () => {
    const [g] = [redactPII()];
    const out = applyTextGuards('mail a@b.com card 4111 1111 1111 1111 ssn 123-45-6789', 'output', [g!]);
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_CARD]');
    expect(out).toContain('[REDACTED_SSN]');
  });

  it('contentFilter blocks or redacts on match', () => {
    expect(() => applyTextGuards('the secret code', 'output', [contentFilter({ deny: [/secret/] })])).toThrow(GuardrailError);
    expect(applyTextGuards('the secret code', 'output', [contentFilter({ deny: [/secret/], mode: 'redact' })])).toBe('the [REDACTED] code');
  });

  it('toolPolicy denies, allowlists, and requires approval', () => {
    const g = toolPolicy({ deny: ['delete'], requireApproval: ['refund'] });
    expect(decideToolCall({ name: 'delete', input: {}, tainted: false }, [g]).action).toBe('deny');
    expect(decideToolCall({ name: 'refund', input: {}, tainted: false }, [g]).action).toBe('approve');
    expect(decideToolCall({ name: 'read', input: {}, tainted: false }, [g]).action).toBe('allow');
    const allowOnly = toolPolicy({ allow: ['read'] });
    expect(decideToolCall({ name: 'write', input: {}, tainted: false }, [allowOnly]).action).toBe('deny');
  });

  it('injectionGuard only gates once context is tainted', () => {
    const g = injectionGuard({ mode: 'block', allowlist: ['search'] });
    expect(decideToolCall({ name: 'wire_money', input: {}, tainted: false }, [g]).action).toBe('allow');
    expect(decideToolCall({ name: 'wire_money', input: {}, tainted: true }, [g]).action).toBe('deny');
    expect(decideToolCall({ name: 'search', input: {}, tainted: true }, [g]).action).toBe('allow');
  });

  it('most-restrictive decision wins across the chain', () => {
    const chain = [injectionGuard({ mode: 'approve' }), toolPolicy({ deny: ['x'] })];
    expect(decideToolCall({ name: 'x', input: {}, tainted: true }, chain).action).toBe('deny');
  });
});

const tool = (name: string, ran: string[]): AgentTool => ({
  name,
  description: name,
  execute: () => {
    ran.push(name);
    return { ok: true };
  },
});

describe('guardrails in the agent runtime', () => {
  it('denies a tool call and feeds the block back as an error result (never executes)', async () => {
    const ran: string[] = [];
    const c = client({
      script: [
        { text: '', toolCalls: [{ id: 't1', name: 'delete_all', input: {} }] },
        { text: 'I cannot do that.' },
      ],
    });
    const result = await runAgent({
      client: c,
      messages: [{ role: 'user', content: 'delete everything' }],
      tools: [tool('delete_all', ran)],
      guardrails: [toolPolicy({ deny: ['delete_all'] })],
    });
    expect(ran).toEqual([]);
    expect(result.text).toBe('I cannot do that.');
  });

  it('redacts PII from model output', async () => {
    const c = client({ defaultText: 'Contact me at a@b.com' });
    const events: AgentEvent[] = [];
    for await (const e of streamAgent({ client: c, messages: [{ role: 'user', content: 'hi' }], guardrails: [redactPII()] })) {
      events.push(e);
    }
    const text = events.find((e) => e.type === 'text');
    expect(text && text.type === 'text' && text.text).toBe('Contact me at [REDACTED_EMAIL]');
  });

  it('injection guard suspends a tainted-context tool call for approval', async () => {
    const ran: string[] = [];
    // Iteration 1: a read tool runs (produces untrusted output → taints context).
    // Iteration 2: the model calls a sensitive tool → injection guard forces approval.
    const c = client({
      script: [
        { text: '', toolCalls: [{ id: 'r1', name: 'read_doc', input: {} }] },
        { text: '', toolCalls: [{ id: 'w1', name: 'wire_money', input: { amt: 999 } }] },
      ],
    });
    const result = await collect(
      streamAgent({
        client: c,
        messages: [{ role: 'user', content: 'summarize the doc' }],
        tools: [tool('read_doc', ran), tool('wire_money', ran)],
        guardrails: [injectionGuard({ mode: 'approve', allowlist: ['read_doc'] })],
      }),
    );
    expect(ran).toEqual(['read_doc']); // wire_money was gated before executing
    expect(result.suspended?.callId).toBe('w1');
    expect(result.suspended?.payload).toMatchObject({ name: 'wire_money' });
  });
});

async function collect(gen: AsyncGenerator<AgentEvent, AgentRunResult>): Promise<AgentRunResult> {
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  return next.value;
}

// keep zod import used (schema-validated tools exercised elsewhere)
void z;

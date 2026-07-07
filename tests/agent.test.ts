import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver } from '../src/llm/drivers/mock.js';
import { defineAgent } from '../src/agent/define.js';
import { encodeDataStreamPart } from '../src/agent/datastream.js';
import { runAgent, streamAgent, type AgentEvent, type AgentTool } from '../src/agent/runtime.js';
import type { MockDriverOptions } from '../src/llm/drivers/mock.js';

function clientWith(options: Omit<MockDriverOptions, 'prefix'>) {
  const driver = new MockDriver({ prefix: 'claude', ...options });
  return { client: new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' }), driver };
}

const weatherTool = (calls: string[]): AgentTool => ({
  name: 'get_weather',
  description: 'Get weather for a city',
  zodSchema: z.object({ city: z.string() }),
  execute: (input) => {
    const { city } = input as { city: string };
    calls.push(city);
    return { tempC: 21, city };
  },
});

describe('runAgent', () => {
  it('returns the final text when the model makes no tool calls', async () => {
    const { client } = clientWith({ defaultText: 'The answer is 42.' });
    const result = await runAgent({ client, messages: [{ role: 'user', content: 'q' }] });
    expect(result.text).toBe('The answer is 42.');
    expect(result.iterations).toBe(1);
    expect(result.stoppedAtCap).toBe(false);
  });

  it('executes a requested tool then finishes with the follow-up answer', async () => {
    const toolCalls: string[] = [];
    const { client, driver } = clientWith({
      script: [
        { text: '', toolCalls: [{ id: 't1', name: 'get_weather', input: { city: 'Paris' } }] },
        { text: 'It is 21C in Paris.' },
      ],
    });
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'weather in Paris?' }],
      tools: [weatherTool(toolCalls)],
    });
    expect(toolCalls).toEqual(['Paris']);
    expect(result.text).toBe('It is 21C in Paris.');
    expect(result.iterations).toBe(2);
    // The second model call saw the tool_result in the conversation.
    const secondCall = driver.calls[1]!;
    const lastMsg = secondCall.messages.at(-1)!;
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect((lastMsg.content as Array<{ type: string }>)[0]!.type).toBe('tool_result');
  });

  it('validates tool input and reports an error result on mismatch', async () => {
    const { client } = clientWith({
      script: [
        { text: '', toolCalls: [{ id: 't1', name: 'get_weather', input: { wrong: 1 } }] },
        { text: 'done' },
      ],
    });
    const events: AgentEvent[] = [];
    for await (const e of streamAgent({
      client,
      messages: [{ role: 'user', content: 'x' }],
      tools: [weatherTool([])],
    })) {
      events.push(e);
    }
    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult && toolResult.type === 'tool_result' && toolResult.isError).toBe(true);
  });

  it('stops at the iteration cap when the model keeps calling tools', async () => {
    // Every response requests another tool call → never terminates on its own.
    const driver = new MockDriver({
      prefix: 'claude',
      script: Array.from({ length: 10 }, (_, i) => ({
        text: '',
        toolCalls: [{ id: `t${i}`, name: 'get_weather', input: { city: 'X' } }],
      })),
    });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    const result = await runAgent({
      client,
      messages: [{ role: 'user', content: 'loop' }],
      tools: [weatherTool([])],
      maxIterations: 3,
    });
    expect(result.iterations).toBe(3);
    expect(result.stoppedAtCap).toBe(true);
  });

  it('aborts before calling the model when the signal is already aborted', async () => {
    const { client, driver } = clientWith({ defaultText: 'unused' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAgent({ client, messages: [{ role: 'user', content: 'x' }], signal: controller.signal }),
    ).rejects.toThrow(/aborted/i);
    expect(driver.calls).toHaveLength(0);
  });

  it('accumulates usage and cost across iterations', async () => {
    const { client } = clientWith({
      script: [
        { text: '', toolCalls: [{ id: 't1', name: 'get_weather', input: { city: 'A' } }], usage: { inputTokens: 100, outputTokens: 10 } },
        { text: 'final', usage: { inputTokens: 120, outputTokens: 8 } },
      ],
    });
    const result = await runAgent({ client, messages: [{ role: 'user', content: 'x' }], tools: [weatherTool([])] });
    expect(result.totalUsage).toEqual({ inputTokens: 220, outputTokens: 18 });
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });
});

describe('encodeDataStreamPart', () => {
  it('encodes each event as an AI-SDK data stream part', () => {
    expect(encodeDataStreamPart({ type: 'text', text: 'hi' }, 'm')).toBe('0:"hi"\n');
    expect(encodeDataStreamPart({ type: 'tool_call', id: 't1', name: 'f', input: { a: 1 } }, 'm')).toBe(
      '9:{"toolCallId":"t1","toolName":"f","args":{"a":1}}\n',
    );
    expect(encodeDataStreamPart({ type: 'tool_result', id: 't1', name: 'f', output: { ok: true }, isError: false }, 'm')).toBe(
      'a:{"toolCallId":"t1","result":{"ok":true}}\n',
    );
    expect(encodeDataStreamPart({ type: 'iteration', n: 1 }, 'm')).toBe('f:{"messageId":"m-1"}\n');
    expect(
      encodeDataStreamPart({ type: 'final', text: 'x', usage: { inputTokens: 5, outputTokens: 2 }, iterations: 1 }, 'm'),
    ).toBe('d:{"finishReason":"stop","usage":{"promptTokens":5,"completionTokens":2}}\n');
  });
});

describe('defineAgent handler', () => {
  it('streams the data stream protocol from a chat request', async () => {
    const { client } = clientWith({ defaultText: 'Hello there' });
    const handler = defineAgent({ client });
    const req = new Request('http://x/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    });
    const { Context } = await import('../src/kernel/context.js');
    const res = await handler(new Context(req));
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).headers.get('x-vercel-ai-data-stream')).toBe('v1');
    const text = await (res as Response).text();
    expect(text).toContain('0:"Hello there"');
    expect(text).toContain('d:{"finishReason":"stop"');
  });

  it('accepts AI SDK message parts (content arrays) and 400s on a missing messages array', async () => {
    const { client, driver } = clientWith({ defaultText: 'ok' });
    const handler = defineAgent({ client });
    const { Context } = await import('../src/kernel/context.js');

    const good = new Request('http://x/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'part-one ' }, { type: 'text', text: 'part-two' }] }] }),
    });
    await (await handler(new Context(good)) as Response).text();
    expect(driver.calls[0]!.messages[0]!.content).toBe('part-one part-two');

    const bad = new Request('http://x/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    await expect(handler(new Context(bad))).rejects.toMatchObject({ status: 400 });
  });
});

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LlmClient, type TraceEvent } from '../src/llm/client.js';
import { computeCost, registerPricing } from '../src/llm/cost.js';
import { MockDriver, flakyScript } from '../src/llm/drivers/mock.js';
import { AnthropicDriver, type AnthropicLike } from '../src/llm/drivers/anthropic.js';
import { OpenAIDriver, type OpenAILike } from '../src/llm/drivers/openai.js';
import { RetryableModelError } from '../src/llm/types.js';

const ask = (content = 'hi') => ({ messages: [{ role: 'user' as const, content }] });

describe('cost', () => {
  it('prices known Anthropic models per 1M tokens', () => {
    expect(computeCost('claude-opus-4-8', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(30);
    expect(computeCost('claude-haiku-4-5', { inputTokens: 2_000_000, outputTokens: 0 })).toBe(2);
  });

  it('returns undefined for unknown models until registered', () => {
    expect(computeCost('gpt-4o', { inputTokens: 1000, outputTokens: 1000 })).toBeUndefined();
    registerPricing('gpt-4o', { input: 2.5, output: 10 });
    expect(computeCost('gpt-4o', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12.5);
  });
});

describe('LlmClient.generate', () => {
  it('routes to the driver that supports the model and tracks cost', async () => {
    const driver = new MockDriver({ prefix: 'claude', provider: 'anthropic' });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    const res = await client.generate({ ...ask(), model: 'claude-opus-4-8' });
    expect(res.provider).toBe('anthropic');
    expect(res.model).toBe('claude-opus-4-8');
    expect(client.totalCostUsd).toBeGreaterThan(0);
    expect(driver.calls).toHaveLength(1);
  });

  it('uses defaultModel when the request omits one', async () => {
    const driver = new MockDriver({ prefix: 'claude' });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    const res = await client.generate(ask());
    expect(res.model).toBe('claude-opus-4-8');
  });

  it('retries transient errors on the same model', async () => {
    const driver = new MockDriver({ prefix: 'claude', script: flakyScript(1, 'recovered') });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8', maxRetries: 3, retryBaseMs: 0 });
    const res = await client.generate(ask());
    expect(res.text).toBe('recovered');
    expect(driver.calls).toHaveLength(2);
  });

  it('falls back to the next model when the primary keeps failing transiently', async () => {
    const primary = new MockDriver({
      prefix: 'claude-opus',
      provider: 'anthropic',
      script: [
        { text: '', error: new RetryableModelError('down') },
        { text: '', error: new RetryableModelError('down') },
      ],
    });
    const backup = new MockDriver({ prefix: 'gpt', provider: 'openai', defaultText: 'from gpt' });
    const events: TraceEvent[] = [];
    const client = new LlmClient({
      drivers: [primary, backup],
      defaultModel: 'claude-opus-4-8',
      fallback: ['gpt-4o'],
      maxRetries: 2,
      retryBaseMs: 0,
      onTrace: (e) => events.push(e),
    });
    const res = await client.generate(ask());
    expect(res.text).toBe('from gpt');
    expect(res.provider).toBe('openai');
    // The successful event is marked as a fallback.
    const success = events.find((e) => e.ok)!;
    expect(success.fallback).toBe(true);
  });

  it('does not fall back on a non-retryable error', async () => {
    const primary = new MockDriver({
      prefix: 'claude',
      script: [{ text: '', error: new Error('bad request 400') }],
    });
    const backup = new MockDriver({ prefix: 'gpt', defaultText: 'unused' });
    const client = new LlmClient({ drivers: [primary, backup], defaultModel: 'claude-opus-4-8', fallback: ['gpt-4o'], retryBaseMs: 0 });
    await expect(client.generate(ask())).rejects.toThrow(/bad request 400/);
    expect(backup.calls).toHaveLength(0);
  });

  it('throws when no driver supports the model chain', async () => {
    const client = new LlmClient({ drivers: [new MockDriver({ prefix: 'mock' })], defaultModel: 'claude-opus-4-8' });
    await expect(client.generate(ask())).rejects.toThrow(/No driver for model/);
  });
});

describe('LlmClient.stream', () => {
  it('yields text chunks then a done event with usage', async () => {
    const driver = new MockDriver({ prefix: 'claude', defaultText: 'hello world stream' });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    let text = '';
    let done = false;
    for await (const ev of client.stream(ask())) {
      if (ev.type === 'text') text += ev.text;
      if (ev.type === 'done') done = true;
    }
    expect(text).toBe('hello world stream');
    expect(done).toBe(true);
    expect(client.totalCostUsd).toBeGreaterThan(0);
  });
});

describe('LlmClient.generateObject', () => {
  const schema = z.object({ city: z.string(), pop: z.number() });

  it('parses and validates structured output', async () => {
    const driver = new MockDriver({ prefix: 'claude', defaultText: JSON.stringify({ city: 'Paris', pop: 2_000_000 }) });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    const res = await client.generateObject(ask('capital of France'), schema);
    expect(res.object).toEqual({ city: 'Paris', pop: 2_000_000 });
    // The request carried a json_schema response format.
    expect(driver.calls[0]!.responseFormat?.type).toBe('json_schema');
  });

  it('strips ```json fences before parsing', async () => {
    const driver = new MockDriver({ prefix: 'claude', defaultText: '```json\n{"city":"Rome","pop":3}\n```' });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    const res = await client.generateObject(ask(), schema);
    expect(res.object.city).toBe('Rome');
  });

  it('repairs by re-prompting with the validation error, then succeeds', async () => {
    const driver = new MockDriver({
      prefix: 'claude',
      script: [
        { text: '{"city":"Berlin"}' }, // missing pop → zod fails
        { text: '{"city":"Berlin","pop":4}' }, // repaired
      ],
    });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    const res = await client.generateObject(ask(), schema, { maxRepairs: 2 });
    expect(res.object).toEqual({ city: 'Berlin', pop: 4 });
    expect(driver.calls).toHaveLength(2);
    // The repair turn fed the error back to the model.
    const repairMsg = driver.calls[1]!.messages.at(-1)!;
    expect(repairMsg.role).toBe('user');
    expect(repairMsg.content).toMatch(/did not match the required schema/);
  });

  it('gives up after exhausting repairs', async () => {
    const driver = new MockDriver({ prefix: 'claude', defaultText: '{"nope":true}' });
    const client = new LlmClient({ drivers: [driver], defaultModel: 'claude-opus-4-8' });
    await expect(client.generateObject(ask(), schema, { maxRepairs: 1 })).rejects.toThrow(/failed to produce schema-valid/);
  });
});

describe('AnthropicDriver mapping (injected fake client)', () => {
  it('lifts system messages, sets adaptive thinking + structured format, extracts text/usage', async () => {
    const create = vi.fn(async (_params: Record<string, unknown>) => ({
      content: [
        { type: 'thinking', text: '' },
        { type: 'text', text: 'Bonjour' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 3 },
    }));
    const fake: AnthropicLike = { messages: { create } };
    const driver = new AnthropicDriver({ client: fake });

    const res = await driver.generate({
      model: 'claude-opus-4-8',
      system: 'be brief',
      messages: [
        { role: 'system', content: 'extra system' },
        { role: 'user', content: 'hi' },
      ],
      thinking: true,
      effort: 'high',
      responseFormat: { type: 'json_schema', schema: { type: 'object' } },
    });

    expect(res.text).toBe('Bonjour');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 3, cacheReadTokens: undefined, cacheWriteTokens: undefined });
    const params = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.system).toBe('be brief\n\nextra system');
    expect(params.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
  });

  it('classifies 429 as retryable', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('rate limited'), { status: 429 });
    });
    const driver = new AnthropicDriver({ client: { messages: { create } } });
    await expect(driver.generate(ask('x'))).rejects.toBeInstanceOf(RetryableModelError);
  });
});

describe('OpenAIDriver mapping (injected fake client)', () => {
  it('maps system+messages and reads choices/usage', async () => {
    const create = vi.fn(async (_params: Record<string, unknown>) => ({
      choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }));
    const fake: OpenAILike = { chat: { completions: { create } } };
    const driver = new OpenAIDriver({ client: fake });
    const res = await driver.generate({ model: 'gpt-4o', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('hello');
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    const params = create.mock.calls[0]![0] as { messages: unknown[] };
    expect(params.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
  });
});

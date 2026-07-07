import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { GeminiDriver, type GeminiLike } from '../src/llm/drivers/gemini.js';
import { runAgent, type AgentTool } from '../src/agent/runtime.js';
import { RetryableModelError } from '../src/llm/types.js';

describe('GeminiDriver mapping (injected fake)', () => {
  it('folds system, maps contents/tools, extracts text + function calls', async () => {
    const generate = vi.fn(async (_args: Record<string, unknown>) => ({
      text: 'Bonjour',
      functionCalls: [{ name: 'get_weather', args: { city: 'Paris' } }],
      usage: { promptTokenCount: 12, candidatesTokenCount: 4 },
      finishReason: 'STOP',
    }));
    const fake: GeminiLike = { generate };
    const driver = new GeminiDriver({ client: fake });

    const res = await driver.generate({
      model: 'gemini-2.5-flash',
      system: 'be brief',
      messages: [
        { role: 'system', content: 'extra' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{ name: 'get_weather', description: 'weather', inputSchema: { type: 'object' } }],
    });

    expect(res.text).toBe('Bonjour');
    expect(res.provider).toBe('gemini');
    expect(res.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(res.toolCalls).toEqual([{ id: 'get_weather::0', name: 'get_weather', input: { city: 'Paris' } }]);

    const args = generate.mock.calls[0]![0] as {
      systemInstruction: string;
      contents: Array<{ role: string; parts: unknown[] }>;
      tools: Array<{ functionDeclarations: unknown[] }>;
    };
    expect(args.systemInstruction).toBe('be brief\n\nextra');
    expect(args.contents).toEqual([{ role: 'user', parts: [{ text: 'weather?' }] }]);
    expect(args.tools[0]!.functionDeclarations).toHaveLength(1);
  });

  it('maps assistant tool_use to functionCall and tool_result back to functionResponse (name recovered)', async () => {
    const generate = vi.fn(async (_args: Record<string, unknown>) => ({ text: 'done', functionCalls: undefined }));
    const driver = new GeminiDriver({ client: { generate } });

    await driver.generate({
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'get_weather::0', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'get_weather::0', content: '{"tempC":21}' }] },
      ],
    });

    const contents = (generate.mock.calls[0]![0] as { contents: Array<{ role: string; parts: unknown[] }> }).contents;
    expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] });
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { tempC: 21 } } }],
    });
  });

  it('classifies 503 / overloaded as retryable', async () => {
    const driver = new GeminiDriver({
      client: {
        generate: async () => {
          throw Object.assign(new Error('model is overloaded'), { status: 503 });
        },
      },
    });
    await expect(driver.generate({ messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(
      RetryableModelError,
    );
  });
});

describe('GeminiDriver in the agent loop', () => {
  it('drives a full tool-calling round trip', async () => {
    // Turn 1: request the tool. Turn 2: final answer.
    let turn = 0;
    const fake: GeminiLike = {
      generate: async () => {
        turn += 1;
        return turn === 1
          ? { text: '', functionCalls: [{ name: 'get_weather', args: { city: 'Paris' } }] }
          : { text: 'It is 21C in Paris.', functionCalls: undefined };
      },
    };
    const client = new LlmClient({ drivers: [new GeminiDriver({ client: fake })], defaultModel: 'gemini-2.5-flash' });
    const executed: string[] = [];
    const tool: AgentTool = {
      name: 'get_weather',
      description: 'weather',
      zodSchema: z.object({ city: z.string() }),
      execute: (input) => {
        const { city } = input as { city: string };
        executed.push(city);
        return { tempC: 21 };
      },
    };
    const result = await runAgent({ client, messages: [{ role: 'user', content: 'weather in Paris?' }], tools: [tool] });
    expect(executed).toEqual(['Paris']);
    expect(result.text).toBe('It is 21C in Paris.');
    expect(result.iterations).toBe(2);
  });
});

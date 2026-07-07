import { describe, expect, it } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver, type MockDriverOptions } from '../src/llm/drivers/mock.js';
import { AgentRegistry, agentAsTool, callAgent, withAgents } from '../src/agent/orchestrate.js';
import { runAgent, type AgentTool } from '../src/agent/runtime.js';
import { createApp } from '../src/kernel/app.js';
import { req, route } from './helpers.js';

const client = (options: Omit<MockDriverOptions, 'prefix'>) =>
  new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', ...options })], defaultModel: 'claude-opus-4-8' });

describe('AgentRegistry', () => {
  it('registers and calls a named agent', async () => {
    const registry = new AgentRegistry().register('translator', { client: client({ defaultText: 'Bonjour' }) });
    expect(registry.names()).toEqual(['translator']);
    const result = await registry.call('translator', 'hello');
    expect(result.text).toBe('Bonjour');
  });

  it('throws calling an unregistered agent', async () => {
    await expect(new AgentRegistry().call('nope', 'x')).rejects.toThrow(/No agent registered/);
  });
});

describe('agentAsTool + orchestrator delegation', () => {
  it('lets an orchestrator agent delegate to a sub-agent via a tool', async () => {
    const registry = new AgentRegistry().register('math', { client: client({ defaultText: '42' }) });
    const delegate: AgentTool = agentAsTool(registry, 'math', { toolName: 'ask_math' });

    // Orchestrator: iteration 1 calls the sub-agent tool, iteration 2 answers.
    const orchestrator = client({
      script: [
        { text: '', toolCalls: [{ id: 'd1', name: 'ask_math', input: { message: 'what is 6*7?' } }] },
        { text: 'The answer is 42.' },
      ],
    });
    const result = await runAgent({ client: orchestrator, messages: [{ role: 'user', content: 'compute 6*7' }], tools: [delegate] });
    expect(result.text).toBe('The answer is 42.');
    // The sub-agent's output flowed back as the tool result.
    const toolResultMsg = result.messages.find(
      (m) => m.role === 'user' && typeof m.content !== 'string' && m.content.some((b) => b.type === 'tool_result'),
    );
    const block = (toolResultMsg!.content as Array<{ type: string; content?: string }>).find((b) => b.type === 'tool_result')!;
    expect(block.content).toBe('42');
  });
});

describe('withAgents / callAgent', () => {
  it('exposes the registry on ctx for handler-level delegation', async () => {
    const registry = new AgentRegistry().register('greeter', { client: client({ defaultText: 'hi there' }) });
    const app = createApp(
      { routes: [route('POST', '/delegate', async (ctx) => ({ reply: (await callAgent(ctx, 'greeter', 'hello')).text }))] },
      { middleware: [withAgents(registry)] },
    );
    const res = await app.fetch(req('POST', '/delegate'));
    expect(await res.json()).toEqual({ reply: 'hi there' });
  });
});

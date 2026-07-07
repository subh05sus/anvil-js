import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver } from '../src/llm/drivers/mock.js';
import { AgentRegistry } from '../src/agent/orchestrate.js';
import { A2AServer, a2aHttpHandler } from '../src/a2a/index.js';
import { serve, type AnvilServer } from '../src/kernel/adapter-node.js';

function makeServer() {
  const registry = new AgentRegistry()
    .register('translator', { client: new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', defaultText: 'Bonjour' })], defaultModel: 'claude-opus-4-8' }) });
  return new A2AServer({
    registry,
    name: 'Anvil Example',
    description: 'A translator agent',
    url: 'http://localhost/a2a',
    skills: [{ id: 'translator', name: 'Translate', description: 'Translate to French' }],
  });
}

describe('A2AServer', () => {
  const server = makeServer();

  it('produces an agent card with skills', () => {
    const card = server.agentCard();
    expect(card.name).toBe('Anvil Example');
    expect(card.protocolVersion).toBeTruthy();
    expect(card.skills.map((s) => s.id)).toEqual(['translator']);
  });

  it('runs the agent on message/send and returns a completed task', async () => {
    const res = (await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hello' }], messageId: 'm1' } },
    })) as { result: { status: { state: string }; artifacts: Array<{ parts: Array<{ text: string }> }>; id: string } };
    expect(res.result.status.state).toBe('completed');
    expect(res.result.artifacts[0]!.parts[0]!.text).toBe('Bonjour');

    // tasks/get returns the stored task.
    const got = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: res.result.id } })) as {
      result: { id: string };
    };
    expect(got.result.id).toBe(res.result.id);
  });

  it('errors on unknown method and missing task', async () => {
    expect(((await server.handle({ jsonrpc: '2.0', id: 3, method: 'bogus' })) as { error: { code: number } }).error.code).toBe(-32601);
    expect(((await server.handle({ jsonrpc: '2.0', id: 4, method: 'tasks/get', params: { id: 'nope' } })) as { error: { code: number } }).error.code).toBe(-32001);
  });
});

describe('a2aHttpHandler (over real fetch)', () => {
  let running: AnvilServer;
  let base: string;
  beforeAll(async () => {
    running = await serve({ fetch: a2aHttpHandler(makeServer()) }, { port: 0, hostname: '127.0.0.1' });
    base = `http://127.0.0.1:${running.port}`;
  });
  afterAll(() => running.close());

  it('serves the agent card at the well-known path', async () => {
    const res = await fetch(`${base}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { name: string }).name).toBe('Anvil Example');
  });

  it('handles message/send over POST', async () => {
    const res = await fetch(`${base}/a2a`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } } }),
    });
    const json = (await res.json()) as { result: { artifacts: Array<{ parts: Array<{ text: string }> }> } };
    expect(json.result.artifacts[0]!.parts[0]!.text).toBe('Bonjour');
  });
});

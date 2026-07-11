import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver } from '../src/llm/drivers/mock.js';
import { AgentRegistry } from '../src/agent/orchestrate.js';
import { A2AServer, a2aHttpHandler } from '../src/a2a/index.js';
import { serve, type AnvilServer } from '../src/kernel/adapter-node.js';
import { MemoryStateStore } from '../src/store/index.js';
import type { GenerateRequest, GenerateResult, ModelDriver, StreamEvent } from '../src/llm/types.js';

/** A driver that never completes until its request signal aborts. */
class HangingDriver implements ModelDriver {
  readonly provider = 'mock';
  supports(model: string): boolean {
    return model.startsWith('claude');
  }
  async generate(req: GenerateRequest): Promise<GenerateResult> {
    await new Promise<void>((_resolve, reject) => {
      if (req.signal?.aborted) return reject(new Error('aborted'));
      req.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
    throw new Error('unreachable');
  }
  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    await this.generate(req);
    yield { type: 'done', result: {} as GenerateResult };
  }
}

/** Read SSE `data:` frames from a stream until it closes; returns parsed results. */
async function collectSse(stream: ReadableStream<Uint8Array>, max = 50): Promise<unknown[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const out: unknown[] = [];
  let buffer = '';
  while (out.length < max) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame.replace(/^data: /, '');
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

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

describe('A2A streaming, persistence, cancellation', () => {
  it('advertises streaming capability', () => {
    expect(makeServer().agentCard().capabilities.streaming).toBe(true);
  });

  it('streams working → artifact delta → completed final', async () => {
    const server = makeServer();
    const stream = server.messageStream(1, {
      message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] },
    });
    const frames = (await collectSse(stream)) as Array<{ result: { kind?: string; status?: { state: string }; final?: boolean; artifact?: { parts: Array<{ text: string }> } } }>;
    const kinds = frames.map((f) => f.result.kind ?? 'task');
    expect(kinds[0]).toBe('task'); // initial snapshot
    expect(kinds).toContain('artifact-update');
    const last = frames.at(-1)!.result;
    expect(last.kind).toBe('status-update');
    expect(last.status!.state).toBe('completed');
    expect(last.final).toBe(true);
    const artifactText = frames
      .filter((f) => f.result.kind === 'artifact-update')
      .map((f) => f.result.artifact!.parts[0]!.text)
      .join('');
    expect(artifactText).toBe('Bonjour');
  });

  it('persists tasks across a "restart" (shared store)', async () => {
    const store = new MemoryStateStore();
    const registry = new AgentRegistry().register('translator', {
      client: new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', defaultText: 'Bonjour' })], defaultModel: 'claude-opus-4-8' }),
    });
    const opts = { registry, name: 'x', description: 'y', url: 'http://localhost/a2a', store };
    const server1 = new A2AServer(opts);
    const res = (await server1.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } },
    })) as { result: { id: string } };

    // A fresh server over the same store still resolves the task.
    const server2 = new A2AServer(opts);
    const got = (await server2.handle({ jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: res.result.id } })) as {
      result: { id: string };
    };
    expect(got.result.id).toBe(res.result.id);
  });

  it('tasks/cancel aborts a running stream and marks it canceled', async () => {
    const registry = new AgentRegistry().register('translator', {
      client: new LlmClient({ drivers: [new HangingDriver()], defaultModel: 'claude-opus-4-8', retryBaseMs: 0 }),
    });
    const server = new A2AServer({ registry, name: 'x', description: 'y', url: 'http://localhost/a2a' });
    const stream = server.messageStream(1, { message: { role: 'user', parts: [{ kind: 'text', text: 'hi' }] } });
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    // First frame carries the initial Task with its id.
    const first = await reader.read();
    const firstFrame = JSON.parse(decoder.decode(first.value).replace(/^data: /, '').trim()) as {
      result: { id: string };
    };
    const taskId = firstFrame.result.id;

    const canceled = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: taskId } })) as {
      result: { status: { state: string } };
    };
    expect(canceled.result.status.state).toBe('canceled');

    // The stream must then terminate with a canceled status-update.
    let tail = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += decoder.decode(value);
    }
    expect(tail).toContain('"state":"canceled"');
  });
});

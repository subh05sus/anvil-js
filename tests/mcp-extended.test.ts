import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type AnvilServer } from '../src/kernel/adapter-node.js';
import { buildServer } from '../src/mcp/build.js';
import { mcpHttpHandler } from '../src/mcp/http.js';
import { McpServer } from '../src/mcp/server.js';
import { McpSessionStore, sseStream } from '../src/mcp/session.js';
import { PromptRegistry } from '../src/prompt/index.js';
import { promptsFromRegistry } from '../src/mcp/prompts.js';
import { MemoryStateStore } from '../src/store/index.js';
import type { BuiltServer } from '../src/mcp/build.js';

const mcpFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp');
const jiti = createJiti(import.meta.url, { interopDefault: false });
const importer = (file: string) => jiti.import(file);

const build = (): Promise<BuiltServer> =>
  buildServer({
    routesDir: path.join(mcpFixture, 'routes'),
    toolsDir: path.join(mcpFixture, 'tools'),
    resourcesDir: path.join(mcpFixture, 'resources'),
    promptsDir: path.join(mcpFixture, 'prompts'),
    importer,
  });

async function server(): Promise<McpServer> {
  const built = await build();
  return new McpServer({ info: { name: 'test', version: '1' }, ...built });
}

describe('buildServer discovery', () => {
  it('discovers resources, templates, and prompts', async () => {
    const built = await build();
    expect(built.resources.map((r) => r.uri)).toContain('anvil://greeting');
    expect(built.resourceTemplates.map((r) => r.uriTemplate)).toContain('anvil://users/{id}');
    expect(built.prompts.map((p) => p.name)).toContain('summarize');
  });
});

describe('McpServer resources', () => {
  it('advertises resource + prompt capabilities when registered', async () => {
    const res = (await (await server()).handle({ jsonrpc: '2.0', id: 1, method: 'initialize' })) as {
      result: { capabilities: Record<string, unknown> };
    };
    expect(res.result.capabilities.resources).toBeTruthy();
    expect(res.result.capabilities.prompts).toBeTruthy();
  });

  it('lists and reads a static resource', async () => {
    const s = await server();
    const list = (await s.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })) as {
      result: { resources: Array<{ uri: string }> };
    };
    expect(list.result.resources.map((r) => r.uri)).toContain('anvil://greeting');

    const read = (await s.handle({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'anvil://greeting' } })) as {
      result: { contents: Array<{ text: string }> };
    };
    expect(read.result.contents[0]!.text).toBe('Hello from Anvil');
  });

  it('reads a templated resource, extracting variables', async () => {
    const read = (await (await server()).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'anvil://users/42' },
    })) as { result: { contents: Array<{ text: string }> } };
    expect(JSON.parse(read.result.contents[0]!.text)).toEqual({ id: '42' });
  });

  it('errors on an unknown resource with -32002', async () => {
    const read = (await (await server()).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'anvil://nope' },
    })) as { error: { code: number } };
    expect(read.error.code).toBe(-32002);
  });
});

describe('McpServer prompts', () => {
  it('lists prompts with derived arguments', async () => {
    const list = (await (await server()).handle({ jsonrpc: '2.0', id: 1, method: 'prompts/list' })) as {
      result: { prompts: Array<{ name: string; arguments?: Array<{ name: string }> }> };
    };
    const summarize = list.result.prompts.find((p) => p.name === 'summarize')!;
    expect(summarize.arguments!.map((a) => a.name).sort()).toEqual(['style', 'text']);
  });

  it('renders a prompt via prompts/get', async () => {
    const got = (await (await server()).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/get',
      params: { name: 'summarize', arguments: { style: 'formal', text: 'hello' } },
    })) as { result: { messages: Array<{ content: { text: string } }> } };
    expect(got.result.messages[0]!.content.text).toBe('Summarize the following formal text:\n\nhello');
  });
});

describe('promptsFromRegistry bridge', () => {
  it('exposes versioned prompts over MCP', async () => {
    const registry = new PromptRegistry(new MemoryStateStore());
    await registry.register('welcome', 'Hi {{name}}!', 'v1');
    const defs = await promptsFromRegistry(registry);
    const welcome = defs.find((p) => p.name === 'welcome')!;
    expect(welcome.arguments!.map((a) => a.name)).toEqual(['name']);
    const result = await welcome.get({ name: 'Ada' });
    expect(result.messages[0]!.content.text).toBe('Hi Ada!');
  });
});

describe('stateful Streamable HTTP', () => {
  let running: AnvilServer;
  let base: string;
  beforeAll(async () => {
    const handler = mcpHttpHandler(await server(), { stateful: true });
    running = await serve({ fetch: handler }, { port: 0, hostname: '127.0.0.1' });
    base = `http://127.0.0.1:${running.port}`;
  });
  afterAll(() => running.close());

  async function initialize(): Promise<string> {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    });
    expect(res.status).toBe(200);
    return res.headers.get('mcp-session-id')!;
  }

  it('mints a session id on initialize and honors it on subsequent calls', async () => {
    const sid = await initialize();
    expect(sid).toBeTruthy();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { tools: unknown[] } };
    expect(Array.isArray(json.result.tools)).toBe(true);
  });

  it('404s an unknown session', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': 'bogus' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  it('rejects a bad protocol-version header with 400', async () => {
    const sid = await initialize();
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': sid, 'mcp-protocol-version': '1999-01-01' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects JSON-RPC batches with 400', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }]),
    });
    expect(res.status).toBe(400);
  });

  it('DELETE terminates a session', async () => {
    const sid = await initialize();
    const del = await fetch(`${base}/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': sid } });
    expect(del.status).toBe(204);
    const after = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
  });

  it('GET without a session 404s', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'GET', headers: { accept: 'text/event-stream' } });
    expect(res.status).toBe(404);
  });
});

describe('stateful SSE notifications', () => {
  it('delivers a broadcast list_changed frame to an open stream', async () => {
    const store = new McpSessionStore();
    const session = store.create('2025-06-18');
    const stream = sseStream(session, undefined);
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    store.broadcast({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    const { value } = await reader.read();
    expect(decoder.decode(value)).toContain('notifications/tools/list_changed');
    await reader.cancel();
  });

  it('cleans up the stream on abort (no lingering handle)', async () => {
    const store = new McpSessionStore();
    const session = store.create('2025-06-18');
    const controller = new AbortController();
    const stream = sseStream(session, controller.signal);
    const reader = stream.getReader();
    // Kick start() by reading once (buffer is empty, so give it a keep-alive tick path).
    expect(session.streams.size).toBe(1);
    controller.abort();
    await reader.cancel().catch(() => {});
    expect(session.streams.size).toBe(0);
  });
});

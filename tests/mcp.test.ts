import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve, type AnvilServer } from '../src/kernel/adapter-node.js';
import { mcpHttpHandler } from '../src/mcp/http.js';
import { McpServer } from '../src/mcp/server.js';
import { processLine } from '../src/mcp/stdio.js';
import { buildToolset } from '../src/mcp/tool.js';
import type { ToolDefinition } from '../src/mcp/types.js';

const mcpFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp');
const jiti = createJiti(import.meta.url, { interopDefault: false });
const importer = (file: string) => jiti.import(file);

const toolset = () =>
  buildToolset({
    routesDir: path.join(mcpFixture, 'routes'),
    toolsDir: path.join(mcpFixture, 'tools'),
    importer,
  });

describe('buildToolset', () => {
  let tools: ToolDefinition[];
  beforeAll(async () => {
    tools = await toolset();
  });

  it('includes only MCP-exposed routes plus registry tools', () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['add', 'get_widgets_by_id']);
  });

  it('derives JSON Schema for the route tool from paramsSchema', () => {
    const widget = tools.find((t) => t.name === 'get_widgets_by_id')!;
    expect(widget.source).toBe('route');
    expect(widget.description).toBe('Fetch a widget by id');
    expect(widget.inputSchema).toEqual({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] });
  });

  it('reads name/description/schema from a registry tool file', () => {
    const add = tools.find((t) => t.name === 'add')!;
    expect(add.source).toBe('registry');
    expect(add.description).toBe('Add two numbers');
    expect(add.inputSchema).toMatchObject({ type: 'object', required: ['a', 'b'] });
  });
});

describe('McpServer', () => {
  let server: McpServer;
  beforeAll(async () => {
    server = new McpServer(await toolset(), { name: 'test', version: '1' });
  });

  it('responds to initialize with protocol + capabilities', async () => {
    const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res).toMatchObject({ id: 1, result: { capabilities: { tools: {} }, serverInfo: { name: 'test' } } });
  });

  it('lists tools', async () => {
    const res = (await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })) as {
      result: { tools: unknown[] };
    };
    expect(res.result.tools).toHaveLength(2);
  });

  it('calls a registry tool and returns text content', async () => {
    const res = (await server.handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 5 } },
    })) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ sum: 7 });
  });

  it('calls a route tool, mapping arguments to params', async () => {
    const res = (await server.handle({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_widgets_by_id', arguments: { id: '2' } },
    })) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(res.result.content[0]!.text)).toEqual({ id: '2', kind: 'flange' });
  });

  it('returns an isError result for invalid arguments (re-validated with Zod)', async () => {
    const res = (await server.handle({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 'not-a-number', b: 1 } },
    })) as { result: { isError?: boolean } };
    expect(res.result.isError).toBe(true);
  });

  it('errors on an unknown tool and unknown method', async () => {
    const unknownTool = (await server.handle({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'nope' },
    })) as { error?: { code: number } };
    expect(unknownTool.error?.code).toBe(-32602);

    const unknownMethod = (await server.handle({ jsonrpc: '2.0', id: 7, method: 'bogus' })) as {
      error?: { code: number };
    };
    expect(unknownMethod.error?.code).toBe(-32601);
  });

  it('returns null for notifications (no id)', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handle({ jsonrpc: '2.0', method: 'ping' })).toBeNull();
  });
});

describe('stdio framing', () => {
  it('serializes one response per line and skips notifications', async () => {
    const server = new McpServer(await toolset(), { name: 'test', version: '1' });
    const line = await processLine(server, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(JSON.parse(line!)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(await processLine(server, '')).toBeNull();
    expect(await processLine(server, JSON.stringify({ jsonrpc: '2.0', method: 'ping' }))).toBeNull();
  });
});

describe('mcpHttpHandler (Streamable HTTP over real fetch)', () => {
  let running: AnvilServer;
  let base: string;

  beforeAll(async () => {
    const server = new McpServer(await toolset(), { name: 'test', version: '1' });
    running = await serve({ fetch: mcpHttpHandler(server) }, { port: 0, hostname: '127.0.0.1' });
    base = `http://127.0.0.1:${running.port}`;
  });
  afterAll(() => running.close());

  const rpc = (body: unknown) =>
    fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('serves tools/call over POST', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'add', arguments: { a: 1, b: 1 } } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(json.result.content[0]!.text)).toEqual({ sum: 2 });
  });

  it('handles JSON-RPC batches', async () => {
    const res = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ]);
    const arr = (await res.json()) as unknown[];
    expect(arr).toHaveLength(2);
  });

  it('returns 202 with no body for a notification-only POST', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
  });

  it('rejects GET with 405 (no server-initiated stream in stateless mode)', async () => {
    const res = await fetch(`${base}/mcp`, { method: 'GET' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('404s for other paths', async () => {
    const res = await fetch(`${base}/other`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(404);
  });
});

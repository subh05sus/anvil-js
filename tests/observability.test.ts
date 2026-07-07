import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/kernel/app.js';
import { dashboardMiddleware } from '../src/trace/dashboard.js';
import { otlpHttpExporter, traceToOtelSpans } from '../src/trace/otel.js';
import { MemoryTraceStore } from '../src/trace/memory-store.js';
import { Tracer } from '../src/trace/tracer.js';
import type { Trace } from '../src/trace/types.js';
import { req } from './helpers.js';

function seededStore(): MemoryTraceStore {
  const store = new MemoryTraceStore();
  const trace = new Tracer(store).start('agent /chat', { route: '/chat' });
  const agent = trace.startSpan('agent', 'agent');
  const model = trace.startSpan('model', 'model', {}, agent.id);
  model.end('ok', { provider: 'anthropic', model: 'claude-opus-4-8', usage: { inputTokens: 10, outputTokens: 4 }, costUsd: 0.001 });
  const tool = trace.startSpan('tool:get_weather', 'tool', { name: 'get_weather' }, agent.id);
  tool.end('ok', { output: { tempC: 21 } });
  agent.end('ok');
  trace.addUsage({ inputTokens: 10, outputTokens: 4 }, 0.001);
  trace.end('ok');
  return store;
}

describe('dashboardMiddleware', () => {
  const store = seededStore();
  const app = createApp({ routes: [], fallbackMiddleware: [dashboardMiddleware(store)] });

  it('serves the bundled HTML page at the base path', async () => {
    const res = await app.fetch(req('GET', '/_anvil'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Anvil');
  });

  it('lists traces (without span payloads) as JSON', async () => {
    const res = await app.fetch(req('GET', '/_anvil/api/traces'));
    const list = (await res.json()) as Array<{ name: string; spans?: unknown }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('agent /chat');
    expect(list[0]!.spans).toBeUndefined();
  });

  it('returns a single trace with its spans', async () => {
    const id = (await (await app.fetch(req('GET', '/_anvil/api/traces'))).json() as Array<{ id: string }>)[0]!.id;
    const res = await app.fetch(req('GET', `/_anvil/api/traces/${id}`));
    const trace = (await res.json()) as Trace;
    expect(trace.spans.map((s) => s.kind).sort()).toEqual(['agent', 'model', 'tool']);
  });

  it('404s an unknown trace and falls through for non-dashboard paths', async () => {
    expect((await app.fetch(req('GET', '/_anvil/api/traces/nope'))).status).toBe(404);
    expect((await app.fetch(req('GET', '/other'))).status).toBe(404); // no route → app 404
  });
});

describe('traceToOtelSpans', () => {
  it('maps spans to OTLP with GenAI semantic-convention attributes', () => {
    const store = seededStore();
    const trace = store.listTraces()[0]!;
    const otlp = traceToOtelSpans(trace);

    const spans = otlp.scopeSpans[0]!.spans;
    expect(spans).toHaveLength(3);
    // Hex ids: traceId 32 chars, spanId 16.
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!.spanId).toMatch(/^[0-9a-f]{16}$/);

    const model = spans.find((s) => s.name === 'model')!;
    const attrKeys = model.attributes.map((a) => a.key);
    expect(attrKeys).toContain('gen_ai.system');
    expect(attrKeys).toContain('gen_ai.request.model');
    expect(attrKeys).toContain('gen_ai.usage.input_tokens');
    const inTokens = model.attributes.find((a) => a.key === 'gen_ai.usage.input_tokens')!;
    expect(inTokens.value.intValue).toBe('10');

    const tool = spans.find((s) => s.name === 'tool:get_weather')!;
    expect(tool.attributes.find((a) => a.key === 'gen_ai.tool.name')!.value.stringValue).toBe('get_weather');
  });
});

describe('otlpHttpExporter', () => {
  it('POSTs the OTLP payload to the endpoint on export', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const store = new MemoryTraceStore();
    const tracer = new Tracer(store, {
      onExport: otlpHttpExporter({ url: 'http://collector/v1/traces', fetch: fetchMock as unknown as typeof fetch }),
    });
    const trace = tracer.start('run');
    trace.startSpan('model', 'model').end('ok', { provider: 'anthropic', model: 'claude-opus-4-8' });
    trace.end('ok');

    // Give the fire-and-forget POST a tick.
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://collector/v1/traces');
    const payload = JSON.parse(init.body as string) as { resourceSpans: unknown[] };
    expect(payload.resourceSpans).toHaveLength(1);
  });
});

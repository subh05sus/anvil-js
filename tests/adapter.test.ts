import { afterAll, describe, expect, it } from 'vitest';
import { serve, type AnvilServer } from '../src/kernel/adapter-node.js';
import { createApp } from '../src/kernel/app.js';
import { route } from './helpers.js';

const servers: AnvilServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function listen() {
  const app = createApp({
    routes: [
      route('GET', '/ping', () => ({ pong: true })),
      route('POST', '/echo', async (ctx) => ({ received: await ctx.body() })),
      route('GET', '/stream', (ctx) =>
        ctx.stream(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('chunk1-'));
              controller.enqueue(new TextEncoder().encode('chunk2'));
              controller.close();
            },
          }),
        ),
      ),
    ],
  });
  const server = await serve(app, { port: 0, hostname: '127.0.0.1' });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe('node adapter (real HTTP round-trip)', () => {
  it('serves GET requests through http.Server', async () => {
    const base = await listen();
    const res = await fetch(`${base}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pong: true });
  });

  it('streams request bodies into the handler', async () => {
    const base = await listen();
    const res = await fetch(`${base}/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 42 }),
    });
    expect(await res.json()).toEqual({ received: { n: 42 } });
  });

  it('streams response bodies out', async () => {
    const base = await listen();
    const res = await fetch(`${base}/stream`);
    expect(await res.text()).toBe('chunk1-chunk2');
  });

  it('propagates 404 and 405 semantics over the wire', async () => {
    const base = await listen();
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    const wrongMethod = await fetch(`${base}/ping`, { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toContain('GET');
  });

  it('serves HEAD without a body', async () => {
    const base = await listen();
    const res = await fetch(`${base}/ping`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });
});

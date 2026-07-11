import { describe, expect, it } from 'vitest';
import { TriggerRegistry, defineTrigger } from '../src/schedule/index.js';
import { buildTriggerHandler } from '../src/cli/serve.js';

function registry() {
  return new TriggerRegistry().register(
    defineTrigger({ name: 'order.created', run: (ctx) => ({ echoed: ctx.payload }) }),
  );
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://t.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('buildTriggerHandler', () => {
  it('fires a known trigger and returns its result', async () => {
    const handler = buildTriggerHandler(registry(), { endpoint: '/triggers' });
    const res = await handler(post('/triggers/order.created', { id: 'A-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { echoed: { id: 'A-1' } } });
  });

  it('404s an unknown trigger', async () => {
    const handler = buildTriggerHandler(registry(), { endpoint: '/triggers' });
    const res = await handler(post('/triggers/nope', {}));
    expect(res.status).toBe(404);
  });

  it('serves /health', async () => {
    const handler = buildTriggerHandler(registry(), { endpoint: '/triggers' });
    const res = await handler(new Request('http://t.local/health'));
    expect(res.status).toBe(200);
  });

  it('requires a bearer token when configured', async () => {
    const handler = buildTriggerHandler(registry(), { endpoint: '/triggers', token: 'secret' });
    const noAuth = await handler(post('/triggers/order.created', {}));
    expect(noAuth.status).toBe(401);
    const badAuth = await handler(post('/triggers/order.created', {}, { authorization: 'Bearer wrong' }));
    expect(badAuth.status).toBe(401);
    const ok = await handler(post('/triggers/order.created', { id: 1 }, { authorization: 'Bearer secret' }));
    expect(ok.status).toBe(200);
  });
});

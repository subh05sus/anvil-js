import { describe, expect, it } from 'vitest';
import { authenticate, bearer, getUser } from '../src/kernel/auth.js';
import { Context } from '../src/kernel/context.js';
import { compose } from '../src/kernel/middleware.js';
import { req } from './helpers.js';

const run = (mw: ReturnType<typeof authenticate>, r: Request, handler = (ctx: Context) => ({ user: getUser(ctx) })) =>
  compose([mw], handler)(new Context(r));

describe('authenticate', () => {
  it('attaches the principal and runs the handler on success', async () => {
    const mw = authenticate({ verify: () => ({ id: 'u1' }) });
    const res = await run(mw, req('GET', '/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { id: 'u1' } });
  });

  it('401s with WWW-Authenticate on failure', async () => {
    const mw = authenticate({ verify: () => null, realm: 'api' });
    const res = await run(mw, req('GET', '/'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="api"');
  });

  it('optional passes through with undefined user', async () => {
    const mw = authenticate({ verify: () => null, optional: true });
    const res = await run(mw, req('GET', '/'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: undefined });
  });

  it('bearer verifier strips the Bearer prefix', async () => {
    const seen: string[] = [];
    const mw = authenticate({
      verify: bearer((token) => {
        seen.push(token);
        return token === 'good' ? { id: 'u1' } : null;
      }),
    });
    const ok = await run(mw, req('GET', '/', { headers: { authorization: 'Bearer good' } }));
    expect(ok.status).toBe(200);
    expect(seen).toEqual(['good']);
    const bad = await run(mw, req('GET', '/', { headers: { authorization: 'Bearer bad' } }));
    expect(bad.status).toBe(401);
    const none = await run(mw, req('GET', '/'));
    expect(none.status).toBe(401);
  });

  it('supports async verify', async () => {
    const mw = authenticate({ verify: async () => ({ id: 'async' }) });
    const res = await run(mw, req('GET', '/'));
    expect(await res.json()).toEqual({ user: { id: 'async' } });
  });
});

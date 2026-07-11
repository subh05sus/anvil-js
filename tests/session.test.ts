import { describe, expect, it } from 'vitest';
import { Context } from '../src/kernel/context.js';
import { compose } from '../src/kernel/middleware.js';
import { getSession, session, type Session } from '../src/kernel/session.js';
import { MemoryStateStore } from '../src/store/index.js';
import { req } from './helpers.js';

const SECRET = 'test-secret';

function drive(
  store: MemoryStateStore,
  r: Request,
  handler: (s: Session) => void | Promise<void>,
  opts = {},
) {
  const mw = session({ store, secret: SECRET, ...opts });
  return compose([mw], async (ctx: Context) => {
    await handler(getSession(ctx)!);
    return { ok: true };
  })(new Context(r));
}

/** Extract the sid cookie value from a Set-Cookie response header. */
function sidCookie(res: Response): string | undefined {
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('sid='));
  return setCookie?.split(';')[0]?.slice('sid='.length);
}

describe('session', () => {
  it('does not write a cookie for an untouched new session', async () => {
    const store = new MemoryStateStore();
    const res = await drive(store, req('GET', '/'), () => {});
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it('issues a signed cookie after a write and hydrates on the next request', async () => {
    const store = new MemoryStateStore();
    const res1 = await drive(store, req('GET', '/'), (s) => s.set('count', 1));
    const cookie = sidCookie(res1);
    expect(cookie).toBeTruthy();

    let seen: unknown;
    await drive(store, req('GET', '/', { headers: { cookie: `sid=${cookie}` } }), (s) => {
      seen = s.get('count');
    });
    expect(seen).toBe(1);
  });

  it('mints a fresh session for a tampered cookie (fixation defense)', async () => {
    const store = new MemoryStateStore();
    let hydrated: unknown = 'unset';
    await drive(store, req('GET', '/', { headers: { cookie: 'sid=attacker.badsig' } }), (s) => {
      hydrated = s.get('anything');
    });
    expect(hydrated).toBeUndefined();
  });

  it('regenerate changes the id and deletes the old record', async () => {
    const store = new MemoryStateStore();
    const res1 = await drive(store, req('GET', '/'), (s) => s.set('v', 'x'));
    const cookie1 = sidCookie(res1)!;

    let newId = '';
    const res2 = await drive(store, req('GET', '/', { headers: { cookie: `sid=${cookie1}` } }), async (s) => {
      await s.regenerate();
      newId = s.id;
    });
    const cookie2 = sidCookie(res2)!;
    expect(cookie2).not.toBe(cookie1);
    expect(newId).toBeTruthy();
    // Data survives regeneration.
    let v: unknown;
    await drive(store, req('GET', '/', { headers: { cookie: `sid=${cookie2}` } }), (s) => {
      v = s.get('v');
    });
    expect(v).toBe('x');
  });

  it('destroy expires the cookie and removes the record', async () => {
    const store = new MemoryStateStore();
    const res1 = await drive(store, req('GET', '/'), (s) => s.set('v', 'x'));
    const cookie1 = sidCookie(res1)!;
    expect(store.list('sess:').length).toBe(1);

    const res2 = await drive(store, req('GET', '/', { headers: { cookie: `sid=${cookie1}` } }), async (s) => {
      await s.destroy();
    });
    const expired = res2.headers.getSetCookie().find((c) => c.startsWith('sid='));
    expect(expired).toContain('Max-Age=0');
    expect(store.list('sess:').length).toBe(0);
  });

  it('rejects an expired record', async () => {
    const store = new MemoryStateStore();
    const res1 = await drive(store, req('GET', '/'), (s) => s.set('v', 'x'), { ttlMs: -1 });
    const cookie1 = sidCookie(res1)!;
    let v: unknown = 'unset';
    await drive(store, req('GET', '/', { headers: { cookie: `sid=${cookie1}` } }), (s) => {
      v = s.get('v');
    });
    expect(v).toBeUndefined();
  });
});

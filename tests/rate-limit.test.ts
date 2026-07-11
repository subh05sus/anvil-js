import { describe, expect, it } from 'vitest';
import { Context } from '../src/kernel/context.js';
import { compose } from '../src/kernel/middleware.js';
import { rateLimit, type RateLimitOptions } from '../src/kernel/rate-limit.js';
import { MemoryStateStore } from '../src/store/index.js';
import { req } from './helpers.js';

function make(opts: RateLimitOptions) {
  const mw = rateLimit(opts);
  return (headers?: Record<string, string>) =>
    compose([mw], () => ({ ok: true }))(new Context(req('GET', '/', headers ? { headers } : undefined)));
}

const ip = (v: string) => ({ 'x-anvil-remote-addr': v });

describe('rateLimit (fixed-window)', () => {
  it('allows up to the limit then 429s with Retry-After', async () => {
    const call = make({ limit: 2, windowMs: 60_000 });
    const r1 = await call(ip('1.1.1.1'));
    expect(r1.status).toBe(200);
    expect(r1.headers.get('ratelimit-remaining')).toBe('1');
    const r2 = await call(ip('1.1.1.1'));
    expect(r2.status).toBe(200);
    expect(r2.headers.get('ratelimit-remaining')).toBe('0');
    const r3 = await call(ip('1.1.1.1'));
    expect(r3.status).toBe(429);
    expect(r3.headers.get('retry-after')).toBeTruthy();
    expect(r3.headers.get('ratelimit-reset')).toBeTruthy();
  });

  it('isolates buckets by key', async () => {
    const call = make({ limit: 1, windowMs: 60_000 });
    expect((await call(ip('1.1.1.1'))).status).toBe(200);
    expect((await call(ip('2.2.2.2'))).status).toBe(200);
    expect((await call(ip('1.1.1.1'))).status).toBe(429);
  });

  it('skip bypasses the limiter', async () => {
    const call = make({ limit: 0, windowMs: 60_000, skip: () => true });
    expect((await call(ip('1.1.1.1'))).status).toBe(200);
  });

  it('works with a StateStore backend', async () => {
    const store = new MemoryStateStore();
    const call = make({ limit: 1, windowMs: 60_000, store });
    expect((await call(ip('9.9.9.9'))).status).toBe(200);
    expect((await call(ip('9.9.9.9'))).status).toBe(429);
  });

  it('resets after the window elapses', async () => {
    const call = make({ limit: 1, windowMs: 1 });
    expect((await call(ip('3.3.3.3'))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect((await call(ip('3.3.3.3'))).status).toBe(200);
  });
});

describe('rateLimit (token-bucket)', () => {
  it('drains then refills', async () => {
    const call = make({ limit: 2, windowMs: 20, algorithm: 'token-bucket' });
    expect((await call(ip('5.5.5.5'))).status).toBe(200);
    expect((await call(ip('5.5.5.5'))).status).toBe(200);
    expect((await call(ip('5.5.5.5'))).status).toBe(429);
    await new Promise((r) => setTimeout(r, 30));
    expect((await call(ip('5.5.5.5'))).status).toBe(200);
  });
});

describe('rateLimit key bounding', () => {
  it('evicts oldest keys past maxKeys', async () => {
    const call = make({ limit: 5, windowMs: 60_000, maxKeys: 2 });
    await call(ip('a'));
    await call(ip('b'));
    await call(ip('c')); // evicts 'a'
    // 'a' evicted → its counter is gone, so it starts fresh (still allowed).
    const r = await call(ip('a'));
    expect(r.headers.get('ratelimit-remaining')).toBe('4');
  });
});

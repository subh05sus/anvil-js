import { describe, expect, it } from 'vitest';
import { Context } from '../src/kernel/context.js';
import { getClientIp, REMOTE_ADDR_HEADER } from '../src/kernel/net.js';
import { req } from './helpers.js';

const ctxWith = (headers: Record<string, string>) => new Context(req('GET', '/', { headers }));

describe('getClientIp', () => {
  it('reads the adapter-injected header by default', () => {
    const ctx = ctxWith({ [REMOTE_ADDR_HEADER]: '10.0.0.5', 'x-forwarded-for': '1.2.3.4' });
    expect(getClientIp(ctx)).toBe('10.0.0.5');
  });

  it('prefers X-Forwarded-For when trustProxy is on', () => {
    const ctx = ctxWith({ [REMOTE_ADDR_HEADER]: '10.0.0.5', 'x-forwarded-for': '1.2.3.4, 10.0.0.1' });
    expect(getClientIp(ctx, { trustProxy: true })).toBe('1.2.3.4');
  });

  it('falls back to the trusted header when no XFF present', () => {
    const ctx = ctxWith({ [REMOTE_ADDR_HEADER]: '10.0.0.5' });
    expect(getClientIp(ctx, { trustProxy: true })).toBe('10.0.0.5');
  });

  it('returns undefined when nothing is available', () => {
    expect(getClientIp(ctxWith({}))).toBeUndefined();
  });
});

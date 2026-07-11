import type { StateStore } from '../store/index.js';
import type { Context } from './context.js';
import { getClientIp } from './net.js';
import type { Middleware } from './types.js';

export interface RateLimitOptions {
  /** Max requests allowed per window (or bucket capacity for token-bucket). */
  limit: number;
  /** Window length in ms (fixed-window), or refill period for `limit` tokens. */
  windowMs: number;
  /** Algorithm. Default: 'fixed-window'. */
  algorithm?: 'fixed-window' | 'token-bucket';
  /** Bucket key. Default: client IP. */
  keyFn?: (ctx: Context) => string;
  /** Distributed backend. Default: an internal bounded in-memory Map. */
  store?: StateStore;
  /** Trust `X-Forwarded-For` for the default IP key. Default: false. */
  trustProxy?: boolean;
  /** Emit `RateLimit-*` headers. Default: true. */
  headers?: boolean;
  /** Body message on 429. */
  message?: string;
  /** Skip rate limiting for a request. */
  skip?: (ctx: Context) => boolean;
  /** Hard cap on in-memory keys (eviction backstop). Default: 100_000. */
  maxKeys?: number;
}

interface Counter {
  /** fixed-window: request count; token-bucket: tokens remaining. */
  value: number;
  /** fixed-window: window reset time; token-bucket: last refill time. */
  ts: number;
}

interface Decision {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

const STORE_PREFIX = 'rl:';

export function rateLimit(options: RateLimitOptions): Middleware {
  const { limit, windowMs } = options;
  const algorithm = options.algorithm ?? 'fixed-window';
  const emitHeaders = options.headers ?? true;
  const maxKeys = options.maxKeys ?? 100_000;
  const message = options.message ?? 'Too Many Requests';
  const keyFn = options.keyFn ?? ((ctx: Context) => getClientIp(ctx, { trustProxy: options.trustProxy }) ?? 'unknown');

  const mem = new Map<string, Counter>();

  function evaluate(counter: Counter | undefined, now: number): { counter: Counter; decision: Decision } {
    if (algorithm === 'token-bucket') {
      let tokens = counter?.value ?? limit;
      const last = counter?.ts ?? now;
      const refill = ((now - last) / windowMs) * limit;
      tokens = Math.min(limit, tokens + refill);
      if (tokens >= 1) {
        tokens -= 1;
        const resetMs = tokens >= limit ? 0 : Math.ceil(((1 - (tokens % 1)) * windowMs) / limit);
        return { counter: { value: tokens, ts: now }, decision: { allowed: true, remaining: Math.floor(tokens), resetMs } };
      }
      const resetMs = Math.ceil(((1 - tokens) * windowMs) / limit);
      return { counter: { value: tokens, ts: now }, decision: { allowed: false, remaining: 0, resetMs } };
    }
    // fixed-window
    if (!counter || counter.ts <= now) {
      const next = { value: 1, ts: now + windowMs };
      return { counter: next, decision: { allowed: true, remaining: limit - 1, resetMs: windowMs } };
    }
    const value = counter.value + 1;
    const resetMs = counter.ts - now;
    if (value > limit) {
      return { counter, decision: { allowed: false, remaining: 0, resetMs } };
    }
    return { counter: { value, ts: counter.ts }, decision: { allowed: true, remaining: limit - value, resetMs } };
  }

  async function read(key: string, now: number): Promise<Counter | undefined> {
    if (options.store) return (await Promise.resolve(options.store.get<Counter>(STORE_PREFIX + key))) ?? undefined;
    const c = mem.get(key);
    // Lazy-evict expired fixed-window entries on access.
    if (c && algorithm === 'fixed-window' && c.ts <= now) {
      mem.delete(key);
      return undefined;
    }
    return c;
  }

  async function write(key: string, counter: Counter): Promise<void> {
    if (options.store) {
      await Promise.resolve(options.store.set(STORE_PREFIX + key, counter));
      return;
    }
    // Bounded Map: evict the oldest entry when at capacity.
    if (!mem.has(key) && mem.size >= maxKeys) {
      const oldest = mem.keys().next().value;
      if (oldest !== undefined) mem.delete(oldest);
    }
    mem.set(key, counter);
  }

  return async (ctx, next) => {
    if (options.skip?.(ctx)) return next();
    const now = Date.now();
    const key = keyFn(ctx);
    const current = await read(key, now);
    const { counter, decision } = evaluate(current, now);
    await write(key, counter);

    const resetSeconds = Math.max(0, Math.ceil(decision.resetMs / 1000));
    if (!decision.allowed) {
      const headers: Record<string, string> = { 'retry-after': String(resetSeconds) };
      if (emitHeaders) {
        headers['ratelimit-limit'] = String(limit);
        headers['ratelimit-remaining'] = '0';
        headers['ratelimit-reset'] = String(resetSeconds);
      }
      return Response.json({ error: message, status: 429 }, { status: 429, headers });
    }

    const response = await next();
    if (emitHeaders) {
      response.headers.set('ratelimit-limit', String(limit));
      response.headers.set('ratelimit-remaining', String(decision.remaining));
      response.headers.set('ratelimit-reset', String(resetSeconds));
    }
    return response;
  };
}

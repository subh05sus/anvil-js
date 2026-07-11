import { randomUUID } from 'node:crypto';
import type { StateStore } from '../store/index.js';
import type { Context } from './context.js';
import { serializeCookie, signValue, unsignValue, type CookieOptions } from './cookies.js';
import { parseCookies } from './cookies.js';
import type { Middleware } from './types.js';

const SESSION_STATE_KEY = 'session';
const KEY_PREFIX = 'sess:';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h idle

export interface SessionOptions {
  /** Backing store for session records. */
  store: StateStore;
  /** HMAC secret(s) for the session cookie. First is current; rest for rotation. */
  secret: string | string[];
  /** Cookie name. Default: 'sid'. */
  cookieName?: string;
  /** Cookie attributes. `httpOnly`/`sameSite: 'Lax'` default on. */
  cookie?: CookieOptions;
  /** Idle expiry in ms. Default: 24h. */
  ttlMs?: number;
  /** Refresh expiry on every request. Default: true. */
  rolling?: boolean;
  /** Session id generator. Default: randomUUID. */
  genId?: () => string;
}

export interface Session {
  readonly id: string;
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  clear(): void;
  /** Rotate to a fresh id, preserving data (call on privilege elevation). */
  regenerate(): Promise<void>;
  /** Destroy the session and expire the cookie. */
  destroy(): Promise<void>;
}

interface SessionRecord {
  data: Record<string, unknown>;
  createdAt: number;
  expiresAt: number;
}

class SessionImpl implements Session {
  id: string;
  data: Record<string, unknown>;
  createdAt: number;
  dirty = false;
  destroyed = false;
  existed: boolean;
  #store: StateStore;

  constructor(store: StateStore, id: string, record: SessionRecord | undefined) {
    this.#store = store;
    this.id = id;
    this.existed = record !== undefined;
    this.data = record?.data ?? {};
    this.createdAt = record?.createdAt ?? Date.now();
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.dirty = true;
  }

  delete(key: string): void {
    delete this.data[key];
    this.dirty = true;
  }

  clear(): void {
    this.data = {};
    this.dirty = true;
  }

  async regenerate(): Promise<void> {
    if (this.existed) await Promise.resolve(this.#store.delete(KEY_PREFIX + this.id));
    this.id = randomUUID();
    this.existed = false;
    this.dirty = true;
  }

  async destroy(): Promise<void> {
    if (this.existed) await Promise.resolve(this.#store.delete(KEY_PREFIX + this.id));
    this.destroyed = true;
  }
}

/**
 * Cookie-based sessions backed by a StateStore. The session id is signed so it
 * can't be forged, and a presented id that isn't already in the store is never
 * adopted (fixation defense) — a fresh random id is minted instead. Writes are
 * lazy: an untouched new session is never persisted.
 */
export function session(options: SessionOptions): Middleware {
  const store = options.store;
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret];
  const cookieName = options.cookieName ?? 'sid';
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const rolling = options.rolling ?? true;
  const genId = options.genId ?? randomUUID;
  const cookieDefaults: CookieOptions = { httpOnly: true, sameSite: 'Lax', path: '/', ...options.cookie };

  return async (ctx, next) => {
    const cookies = parseCookies(ctx.headers.get('cookie'));
    const presented = cookies[cookieName];
    let id: string | undefined;
    let record: SessionRecord | undefined;

    if (presented) {
      const unsigned = unsignValue(presented, secrets);
      if (unsigned) {
        const found = await Promise.resolve(store.get<SessionRecord>(KEY_PREFIX + unsigned));
        if (found && found.expiresAt > Date.now()) {
          id = unsigned;
          record = found;
        }
        // Expired record → drop it so a stale id isn't reused.
        else if (found) await Promise.resolve(store.delete(KEY_PREFIX + unsigned));
      }
    }

    // Never adopt a presented id that isn't a live record; mint a fresh one.
    if (!id) id = genId();

    const sess = new SessionImpl(store, id, record);
    ctx.state[SESSION_STATE_KEY] = sess;

    const response = await next();

    if (sess.destroyed) {
      response.headers.append(
        'set-cookie',
        serializeCookie(cookieName, '', { ...cookieDefaults, maxAge: 0 }),
      );
      return response;
    }

    const shouldWrite = sess.dirty || (rolling && sess.existed);
    if (shouldWrite) {
      const expiresAt = Date.now() + ttlMs;
      const toStore: SessionRecord = { data: sess.data, createdAt: sess.createdAt, expiresAt };
      await Promise.resolve(store.set(KEY_PREFIX + sess.id, toStore));
      response.headers.append(
        'set-cookie',
        serializeCookie(cookieName, signValue(sess.id, secrets[0]!), {
          ...cookieDefaults,
          maxAge: Math.floor(ttlMs / 1000),
        }),
      );
    }
    return response;
  };
}

/** Read the Session an `session` middleware attached, if any. */
export function getSession(ctx: Context): Session | undefined {
  return ctx.state[SESSION_STATE_KEY] as Session | undefined;
}

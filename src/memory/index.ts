import type { Context } from '../kernel/context.js';
import type { Middleware } from '../kernel/types.js';
import type { StateStore } from '../store/index.js';

const PREFIX = 'anvil:memory:';

/**
 * Typed conversational/agent memory (PRD §6.10) over the pluggable StateStore.
 * Namespaced per conversation/session so `ctx.memory` isn't hand-rolled per
 * project. SQLite/Redis backends come from the store adapter.
 */
export class MemoryStore {
  #store: StateStore;
  #namespace: string;

  constructor(store: StateStore, namespace: string) {
    this.#store = store;
    this.#namespace = namespace;
  }

  #key(key: string): string {
    return `${PREFIX}${this.#namespace}:${key}`;
  }

  async get<T>(key: string): Promise<T | undefined> {
    return (await this.#store.get<T>(this.#key(key))) ?? undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.#store.set(this.#key(key), value);
  }

  /** Append to an array value (created if absent). Returns the new length. */
  async append<T>(key: string, item: T): Promise<number> {
    const list = (await this.get<T[]>(key)) ?? [];
    list.push(item);
    await this.set(key, list);
    return list.length;
  }

  async delete(key: string): Promise<void> {
    await this.#store.delete(this.#key(key));
  }

  async keys(): Promise<string[]> {
    const prefix = `${PREFIX}${this.#namespace}:`;
    return (await this.#store.list(prefix)).map((k) => k.slice(prefix.length));
  }
}

const MEMORY_STATE_KEY = 'memory';

/**
 * Attach a per-request MemoryStore to `ctx.state.memory`. The namespace is
 * derived per request (default: an `x-session-id` header or 'default') so each
 * conversation gets its own memory scope.
 */
export function withMemory(store: StateStore, namespace?: (ctx: Context) => string): Middleware {
  return async (ctx, next) => {
    const ns = namespace ? namespace(ctx) : (ctx.headers.get('x-session-id') ?? 'default');
    ctx.state[MEMORY_STATE_KEY] = new MemoryStore(store, ns);
    return next();
  };
}

export function getMemory(ctx: Context): MemoryStore | undefined {
  return ctx.state[MEMORY_STATE_KEY] as MemoryStore | undefined;
}

export const MODULE_STATUS = 'active' as const;

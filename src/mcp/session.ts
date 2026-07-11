import { randomUUID } from 'node:crypto';
import type { JsonRpcNotification } from './types.js';

interface StreamHandle {
  write: (id: number, data: string) => void;
  close: () => void;
}

export interface McpSession {
  id: string;
  protocolVersion: string;
  createdAt: number;
  lastSeenAt: number;
  seq: number;
  streams: Set<StreamHandle>;
}

export interface SessionStoreOptions {
  /** Idle session TTL in ms. Default: 30 min. */
  ttlMs?: number;
  /** Max concurrent sessions before oldest-eviction. Default: 10_000. */
  maxSessions?: number;
}

/**
 * In-memory MCP session registry for the stateful Streamable HTTP transport.
 * Ids are server-minted (randomUUID); expired sessions are swept lazily and a
 * hard cap bounds growth so ids can't be exhausted/brute-forced.
 */
export class McpSessionStore {
  #sessions = new Map<string, McpSession>();
  #ttlMs: number;
  #maxSessions: number;

  constructor(options: SessionStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? 30 * 60 * 1000;
    this.#maxSessions = options.maxSessions ?? 10_000;
  }

  create(protocolVersion: string): McpSession {
    this.#sweep();
    if (this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#sessions.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    const now = Date.now();
    const session: McpSession = {
      id: randomUUID(),
      protocolVersion,
      createdAt: now,
      lastSeenAt: now,
      seq: 0,
      streams: new Set(),
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  get(id: string): McpSession | undefined {
    const session = this.#sessions.get(id);
    if (!session) return undefined;
    if (Date.now() - session.lastSeenAt > this.#ttlMs) {
      this.delete(id);
      return undefined;
    }
    session.lastSeenAt = Date.now();
    return session;
  }

  delete(id: string): void {
    const session = this.#sessions.get(id);
    if (!session) return;
    for (const stream of session.streams) stream.close();
    this.#sessions.delete(id);
  }

  /** Fan a notification out to every open SSE stream across all sessions. */
  broadcast(note: JsonRpcNotification): void {
    const data = JSON.stringify(note);
    for (const session of this.#sessions.values()) {
      for (const stream of [...session.streams]) {
        try {
          stream.write(++session.seq, data);
        } catch {
          session.streams.delete(stream);
        }
      }
    }
  }

  #sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (now - session.lastSeenAt > this.#ttlMs) this.delete(id);
    }
  }
}

/**
 * Build the standing server→client SSE stream for a session. Cleanup is bound
 * to both the request abort signal (primary, since the Node adapter pipes the
 * body and won't always fire `cancel()`) and the stream's `cancel()`, and is
 * idempotent — no leaked keep-alive interval or dead controller.
 */
export function sseStream(session: McpSession, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let handle: StreamHandle | undefined;
  let cleanedUp = false;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (keepAlive) clearInterval(keepAlive);
        if (handle) session.streams.delete(handle);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      handle = {
        write: (id, data) => controller.enqueue(encoder.encode(`id: ${id}\nevent: message\ndata: ${data}\n\n`)),
        close: cleanup,
      };
      session.streams.add(handle);

      keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          cleanup();
        }
      }, 15_000);
      keepAlive.unref?.();

      signal?.addEventListener('abort', cleanup, { once: true });
      // Expose cleanup for the stream's own cancel().
      (this as { _cleanup?: () => void })._cleanup = cleanup;
    },
    cancel() {
      (this as { _cleanup?: () => void })._cleanup?.();
    },
  });
}

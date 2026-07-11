import { HttpError } from './errors.js';

export type QueryValue = string | string[];

/**
 * State key the `bodyLimit` middleware sets to a max byte count. Read inside
 * `#parseBody` so the cap is enforced while reading the stream — before the
 * whole payload is buffered (chunked requests carry no Content-Length).
 * Declared here to avoid an import cycle with `body-limit.ts`.
 */
export const BODY_LIMIT_STATE_KEY = '__bodyLimitBytes';

/**
 * Per-request context. Immutable request view plus response helpers —
 * Anvil's replacement for Express's mutation-heavy (req, res) pair.
 */
export class Context {
  readonly req: Request;
  readonly url: URL;
  readonly params: Record<string, string>;
  /** Scratch space for middleware to pass data down the chain (e.g. auth user). */
  readonly state: Record<string, unknown> = {};

  #query: Record<string, QueryValue> | undefined;
  #bodyPromise: Promise<unknown> | undefined;

  constructor(req: Request, params: Record<string, string> = {}) {
    this.req = req;
    this.url = new URL(req.url);
    this.params = params;
  }

  get method(): string {
    return this.req.method;
  }

  get path(): string {
    return this.url.pathname;
  }

  get headers(): Headers {
    return this.req.headers;
  }

  /** Query string as a plain object; repeated keys collect into arrays. */
  get query(): Record<string, QueryValue> {
    if (!this.#query) {
      const out: Record<string, QueryValue> = {};
      for (const [key, value] of this.url.searchParams) {
        const existing = out[key];
        if (existing === undefined) out[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else out[key] = [existing, value];
      }
      this.#query = out;
    }
    return this.#query;
  }

  /**
   * Parse the request body by content-type: JSON, urlencoded/multipart forms
   * (as FormData), or text. Result is cached — safe to call from both
   * middleware and handler.
   */
  body<T = unknown>(): Promise<T> {
    if (!this.#bodyPromise) {
      this.#bodyPromise = this.#parseBody();
    }
    return this.#bodyPromise as Promise<T>;
  }

  async #parseBody(): Promise<unknown> {
    const type = this.req.headers.get('content-type') ?? '';
    const limit = this.state[BODY_LIMIT_STATE_KEY] as number | undefined;
    try {
      if (limit !== undefined && this.req.body) {
        // Enforce the cap while reading so an oversized (or Content-Length-less
        // chunked) body is rejected mid-stream, not after full buffering.
        const bytes = await this.#readLimited(this.req.body, limit);
        const res = new Response(bytes, { headers: type ? { 'content-type': type } : undefined });
        if (type.includes('application/json')) return await res.json();
        if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
          return await res.formData();
        }
        return await res.text();
      }
      if (type.includes('application/json')) return await this.req.json();
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        return await this.req.formData();
      }
      return await this.req.text();
    } catch (cause) {
      if (cause instanceof HttpError) throw cause;
      throw new HttpError(400, 'Malformed request body', { cause });
    }
  }

  async #readLimited(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > limit) {
            await reader.cancel();
            throw new HttpError(413, 'Payload Too Large');
          }
          chunks.push(value);
        }
      }
    } finally {
      reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  // ── Response helpers ──────────────────────────────────────────────

  json(data: unknown, init?: ResponseInit): Response {
    return Response.json(data, init);
  }

  text(data: string, init?: ResponseInit): Response {
    return new Response(data, withContentType(init, 'text/plain; charset=utf-8'));
  }

  html(data: string, init?: ResponseInit): Response {
    return new Response(data, withContentType(init, 'text/html; charset=utf-8'));
  }

  redirect(location: string, status = 302): Response {
    return new Response(null, { status, headers: { location } });
  }

  stream(body: ReadableStream, init?: ResponseInit): Response {
    return new Response(body, init);
  }
}

function withContentType(init: ResponseInit | undefined, contentType: string): ResponseInit {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type')) headers.set('content-type', contentType);
  return { ...init, headers };
}

/** Normalize whatever a handler/middleware returned into a Response. */
export function toResponse(result: unknown): Response {
  if (result instanceof Response) return result;
  if (result === null || result === undefined) return new Response(null, { status: 204 });
  if (typeof result === 'string') {
    return new Response(result, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  return Response.json(result);
}

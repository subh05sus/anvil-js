import { HttpError } from './errors.js';

export type QueryValue = string | string[];

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
    try {
      if (type.includes('application/json')) return await this.req.json();
      if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
        return await this.req.formData();
      }
      return await this.req.text();
    } catch (cause) {
      throw new HttpError(400, 'Malformed request body', { cause });
    }
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

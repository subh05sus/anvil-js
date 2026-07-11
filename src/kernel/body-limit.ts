import { BODY_LIMIT_STATE_KEY } from './context.js';
import { HttpError } from './errors.js';
import type { Middleware } from './types.js';

export interface BodyLimitOptions {
  /** Maximum request body size in bytes. Bodies over this are rejected with 413. */
  maxBytes: number;
}

/**
 * Reject oversized request bodies (413). A present `Content-Length` over the
 * cap is rejected immediately; otherwise the cap is enforced inside
 * `ctx.body()` while the stream is read, so chunked uploads (which carry no
 * Content-Length) can't bypass it by never advertising a length.
 */
export function bodyLimit(options: BodyLimitOptions): Middleware {
  const { maxBytes } = options;
  return async (ctx, next) => {
    const contentLength = ctx.headers.get('content-length');
    if (contentLength !== null) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new HttpError(413, 'Payload Too Large');
      }
    }
    // The streaming guard runs when the handler calls ctx.body().
    ctx.state[BODY_LIMIT_STATE_KEY] = maxBytes;
    return next();
  };
}

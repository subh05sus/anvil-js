import type { Context } from './context.js';

/**
 * Header the Node adapter uses to hand the trusted client IP to the app.
 * The adapter deletes any client-supplied copy and sets it from the socket,
 * so a client cannot forge it. Web-standard `Request` carries no socket info,
 * so this header is the only trustworthy IP channel.
 */
export const REMOTE_ADDR_HEADER = 'x-anvil-remote-addr';

export interface ClientIpOptions {
  /**
   * Trust `X-Forwarded-For`. Only enable behind a proxy you control — the
   * header is client-settable otherwise. Default: false.
   */
  trustProxy?: boolean;
}

/**
 * Resolve the client IP. By default reads the adapter-injected
 * `x-anvil-remote-addr` (un-spoofable). With `trustProxy`, prefers the
 * left-most `X-Forwarded-For` entry (the original client per the proxy).
 */
export function getClientIp(ctx: Context, opts: ClientIpOptions = {}): string | undefined {
  if (opts.trustProxy) {
    const xff = ctx.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return ctx.headers.get(REMOTE_ADDR_HEADER) ?? undefined;
}

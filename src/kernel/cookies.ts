import { createHmac, timingSafeEqual } from 'node:crypto';

/** Attributes for a `Set-Cookie` header. */
export interface CookieOptions {
  /** Max-Age in seconds. */
  maxAge?: number;
  expires?: Date;
  domain?: string;
  /** Path scope. Default: '/'. */
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Parse a `Cookie` request header into a name→value map. Returns {} for null/empty. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    // Strip surrounding double quotes if present.
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** Serialize a `Set-Cookie` header value. `SameSite=None` implies `Secure`. */
export function serializeCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  const path = opts.path ?? '/';
  parts.push(`Path=${path}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  const sameSite = opts.sameSite;
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure || sameSite === 'None') parts.push('Secure');
  return parts.join('; ');
}

function hmac(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

/** Append an HMAC-SHA256 signature: `value.signature` (base64url). */
export function signValue(value: string, secret: string): string {
  return `${value}.${hmac(value, secret)}`;
}

/**
 * Verify a signed value against one or more secrets (first is current, rest are
 * for rotation). Returns the raw value, or null if the signature is invalid.
 */
export function unsignValue(signed: string, secrets: string | string[]): string | null {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const sigBuf = Buffer.from(sig);
  for (const secret of list) {
    const expected = Buffer.from(hmac(value, secret));
    if (expected.length === sigBuf.length && timingSafeEqual(expected, sigBuf)) {
      return value;
    }
  }
  return null;
}

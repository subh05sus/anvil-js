import type { Context } from './context.js';
import type { Middleware } from './types.js';

const USER_STATE_KEY = 'user';

export interface AuthenticateOptions<U = unknown> {
  /** Resolve the authenticated principal, or null/undefined to reject. */
  verify: (ctx: Context) => U | null | undefined | Promise<U | null | undefined>;
  /** When true, an unauthenticated request passes through (getUser → undefined). */
  optional?: boolean;
  /** ctx.state key to store the principal under. Default: 'user'. */
  stateKey?: string;
  /** `WWW-Authenticate` realm on 401. */
  realm?: string;
}

/**
 * Authentication middleware. Runs `verify(ctx)`; on success attaches the
 * principal to `ctx.state` (read it with `getUser`). On failure returns a 401
 * with a `WWW-Authenticate` header — returned directly rather than thrown,
 * because the error renderer can't attach custom response headers.
 */
export function authenticate<U = unknown>(options: AuthenticateOptions<U>): Middleware {
  const stateKey = options.stateKey ?? USER_STATE_KEY;
  const challenge = `Bearer${options.realm ? ` realm="${options.realm}"` : ''}`;
  return async (ctx, next) => {
    const user = await options.verify(ctx);
    if (user !== null && user !== undefined) {
      ctx.state[stateKey] = user;
      return next();
    }
    if (options.optional) return next();
    return Response.json(
      { error: 'Unauthorized', status: 401 },
      { status: 401, headers: { 'www-authenticate': challenge } },
    );
  };
}

/** Read the principal an `authenticate` middleware attached, if any. */
export function getUser<U = unknown>(ctx: Context, stateKey = USER_STATE_KEY): U | undefined {
  return ctx.state[stateKey] as U | undefined;
}

/** Verifier that reads a `Bearer <token>` Authorization header. */
export function bearer<U = unknown>(
  validate: (token: string, ctx: Context) => U | null | undefined | Promise<U | null | undefined>,
): (ctx: Context) => Promise<U | null | undefined> {
  return async (ctx) => {
    const header = ctx.headers.get('authorization');
    if (!header) return undefined;
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return undefined;
    return validate(match[1]!.trim(), ctx);
  };
}

/** Verifier that reads an API key from a named header. */
export function apiKey<U = unknown>(
  headerName: string,
  validate: (key: string, ctx: Context) => U | null | undefined | Promise<U | null | undefined>,
): (ctx: Context) => Promise<U | null | undefined> {
  const name = headerName.toLowerCase();
  return async (ctx) => {
    const key = ctx.headers.get(name);
    if (!key) return undefined;
    return validate(key, ctx);
  };
}

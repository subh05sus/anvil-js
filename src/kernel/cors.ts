import type { Middleware } from './types.js';

export interface CorsOptions {
  /** Allowed origin(s). '*' (default), a fixed list, or a predicate. */
  origin?: '*' | string[] | ((origin: string) => boolean);
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  credentials?: boolean;
  maxAge?: number;
}

/** CORS middleware (Express `cors` package parity). Handles preflight and decorates responses. */
export function cors(options: CorsOptions = {}): Middleware {
  const {
    origin = '*',
    methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders,
    credentials = false,
    maxAge,
  } = options;

  function resolveOrigin(requestOrigin: string | null): string | null {
    if (requestOrigin === null) return origin === '*' ? '*' : null;
    if (origin === '*') return credentials ? requestOrigin : '*';
    if (Array.isArray(origin)) return origin.includes(requestOrigin) ? requestOrigin : null;
    return origin(requestOrigin) ? requestOrigin : null;
  }

  return async (ctx, next) => {
    const requestOrigin = ctx.headers.get('origin');
    const allowOrigin = resolveOrigin(requestOrigin);

    const baseHeaders = new Headers();
    if (allowOrigin) {
      baseHeaders.set('access-control-allow-origin', allowOrigin);
      if (allowOrigin !== '*') baseHeaders.append('vary', 'Origin');
      if (credentials) baseHeaders.set('access-control-allow-credentials', 'true');
      if (exposedHeaders?.length) baseHeaders.set('access-control-expose-headers', exposedHeaders.join(', '));
    }

    // Preflight
    if (ctx.method === 'OPTIONS' && ctx.headers.has('access-control-request-method')) {
      if (allowOrigin) {
        baseHeaders.set('access-control-allow-methods', methods.join(', '));
        const reqHeaders = allowedHeaders?.join(', ') ?? ctx.headers.get('access-control-request-headers');
        if (reqHeaders) baseHeaders.set('access-control-allow-headers', reqHeaders);
        if (maxAge !== undefined) baseHeaders.set('access-control-max-age', String(maxAge));
      }
      return new Response(null, { status: 204, headers: baseHeaders });
    }

    const response = await next();
    for (const [key, value] of baseHeaders) {
      if (key === 'vary') response.headers.append(key, value);
      else response.headers.set(key, value);
    }
    return response;
  };
}

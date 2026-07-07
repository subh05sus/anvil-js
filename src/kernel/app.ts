import { Context, toResponse } from './context.js';
import { errorToResponse } from './errors.js';
import { compose } from './middleware.js';
import { Router } from './router.js';
import type { Manifest, Middleware } from './types.js';

export interface AppOptions {
  /** Include stack traces in error responses. Default: NODE_ENV !== 'production'. */
  dev?: boolean;
  /** Global middleware run before every route's own chain. */
  middleware?: Middleware[];
  /** Custom error renderer; falls back to the built-in JSON error response. */
  onError?: (err: unknown, ctx: Context) => Response | Promise<Response>;
}

export interface App {
  /** Web-standard fetch handler — the whole framework is Request → Response. */
  fetch: (request: Request) => Promise<Response>;
  router: Router;
}

export function createApp(manifest: Manifest, options: AppOptions = {}): App {
  const router = new Router(manifest.routes);
  const dev = options.dev ?? process.env.NODE_ENV !== 'production';
  const globalMiddleware = options.middleware ?? [];
  const fallbackMiddleware = [...globalMiddleware, ...(manifest.fallbackMiddleware ?? [])];

  async function fetchHandler(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matched = router.match(request.method, url.pathname);

    let ctx: Context;
    if (matched && 'route' in matched) {
      ctx = new Context(request, matched.params);
    } else {
      ctx = new Context(request);
    }

    try {
      if (!matched) {
        return await runFallback(ctx, fallbackMiddleware, () =>
          Response.json({ error: 'Not Found', status: 404 }, { status: 404 }),
        );
      }

      if ('allowed' in matched) {
        const allow = matched.allowed.join(', ');
        // Global middleware still wraps the automatic OPTIONS/405 responses,
        // so e.g. CORS preflight handling works without a route match.
        const run = compose(globalMiddleware, () =>
          request.method === 'OPTIONS'
            ? new Response(null, { status: 204, headers: { allow } })
            : Response.json({ error: 'Method Not Allowed', status: 405 }, { status: 405, headers: { allow } }),
        );
        return await run(ctx);
      }

      const { route } = matched;
      const run = compose([...globalMiddleware, ...route.middleware], route.handler);
      let response = await run(ctx);

      // HEAD served by a GET handler: keep status/headers, drop the body.
      if (request.method === 'HEAD' && route.method === 'GET' && response.body) {
        await response.body.cancel();
        response = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return response;
    } catch (err) {
      if (options.onError) {
        try {
          return await options.onError(err, ctx);
        } catch (rethrown) {
          return errorToResponse(rethrown, { dev });
        }
      }
      return errorToResponse(err, { dev });
    }
  }

  return { fetch: fetchHandler, router };
}

/** Run global middleware even for unmatched paths, so e.g. static-file middleware can serve them. */
async function runFallback(
  ctx: Context,
  middleware: Middleware[],
  notFound: () => Response,
): Promise<Response> {
  if (middleware.length === 0) return notFound();
  const run = compose(middleware, () => notFound());
  return toResponse(await run(ctx));
}

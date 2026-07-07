import type { Context } from './context.js';

/** One parsed segment of a route pattern. Route groups `(group)` are stripped at scan time. */
export type Segment =
  | { type: 'static'; value: string }
  | { type: 'param'; name: string }
  | { type: 'catchall'; name: string };

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * What a handler (or middleware) may return. Anything that is not a `Response`
 * is normalized by the kernel: plain objects/arrays → JSON, strings → text/plain,
 * null/undefined → 204.
 */
export type HandlerResult = Response | object | string | null | undefined | void;

export type Handler = (ctx: Context) => HandlerResult | Promise<HandlerResult>;

export type Next = () => Promise<Response>;

export type Middleware = (ctx: Context, next: Next) => HandlerResult | Promise<HandlerResult>;

/** Per-route metadata (`export const meta = {...}` in a route file). Agentic keys (mcp, a2a, schedule) consumed in later milestones. */
export type RouteMeta = Record<string, unknown>;

export interface RouteDefinition {
  method: HttpMethod;
  /** Original pattern, e.g. `/users/[id]` — for diagnostics and the dashboard. */
  pattern: string;
  segments: Segment[];
  handler: Handler;
  /** Root-to-leaf middleware chain (outermost first). */
  middleware: Middleware[];
  meta?: RouteMeta;
  /** Source file the handler came from — for error messages. */
  file?: string;
}

export interface Manifest {
  routes: RouteDefinition[];
  /**
   * Root-level `_middleware.ts` stack. Route chains already include it; this
   * copy also runs for unmatched paths (404 fallback), so root middleware can
   * serve static files or log every request — Express `app.use` parity.
   */
  fallbackMiddleware?: Middleware[];
}

export interface RouteMatch {
  route: RouteDefinition;
  params: Record<string, string>;
}

/** Result of matching a path where the path exists but not for the requested method. */
export interface MethodMismatch {
  allowed: HttpMethod[];
}

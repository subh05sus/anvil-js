import type { Context } from './context.js';
import { toResponse } from './context.js';
import type { Handler, Middleware } from './types.js';

/**
 * Compose a root-to-leaf middleware chain around a handler (onion model).
 * Each middleware may short-circuit by returning without calling `next()`,
 * or wrap the downstream response.
 */
export function compose(middleware: Middleware[], handler: Handler): (ctx: Context) => Promise<Response> {
  return function run(ctx: Context): Promise<Response> {
    let lastIndex = -1;

    async function dispatch(i: number): Promise<Response> {
      if (i <= lastIndex) {
        throw new Error('next() called multiple times in the same middleware');
      }
      lastIndex = i;
      const fn = middleware[i];
      if (fn) {
        return toResponse(await fn(ctx, () => dispatch(i + 1)));
      }
      return toResponse(await handler(ctx));
    }

    return dispatch(0);
  };
}

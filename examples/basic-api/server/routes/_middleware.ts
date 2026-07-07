import { serveStatic, type Middleware } from 'anvil-sdk';
import { dashboardMiddleware } from 'anvil-sdk/trace';
import { traceStore } from '../trace';

const logger: Middleware = async (ctx, next) => {
  const start = Date.now();
  const res = await next();
  console.log(`${ctx.method} ${ctx.path} → ${res.status} (${Date.now() - start}ms)`);
  return res;
};

// Root middleware also runs for unmatched paths, so the trace dashboard
// (/_anvil) and static files under public/ are served from here.
export default [logger, dashboardMiddleware(traceStore), serveStatic({ dir: 'public' })];

import { serveStatic, type Middleware } from 'anvil';

const logger: Middleware = async (ctx, next) => {
  const start = Date.now();
  const res = await next();
  console.log(`${ctx.method} ${ctx.path} → ${res.status} (${Date.now() - start}ms)`);
  return res;
};

// Root middleware also runs for unmatched paths, so static files under
// public/ are served from here — Express `app.use(express.static(...))` parity.
export default [logger, serveStatic({ dir: 'public' })];

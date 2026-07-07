import type { Middleware } from 'anvil';

const scope: Middleware = async (_ctx, next) => {
  const res = await next();
  res.headers.set('x-scope', 'users');
  return res;
};

export default scope;

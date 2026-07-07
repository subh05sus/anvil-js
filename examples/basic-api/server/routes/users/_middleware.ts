import type { Middleware } from 'anvil-sdk';

const scope: Middleware = async (_ctx, next) => {
  const res = await next();
  res.headers.set('x-scope', 'users');
  return res;
};

export default scope;

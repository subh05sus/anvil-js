import { HttpError, type Middleware } from 'anvil';

const requireAdmin: Middleware = async (ctx, next) => {
  if (ctx.headers.get('x-admin-token') !== 'letmein') {
    throw new HttpError(401, 'Admin token required');
  }
  return next();
};

export default requireAdmin;

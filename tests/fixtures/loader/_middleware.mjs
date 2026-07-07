export default async function rootMiddleware(ctx, next) {
  const res = await next();
  res.headers.set('x-root-mw', '1');
  return res;
}

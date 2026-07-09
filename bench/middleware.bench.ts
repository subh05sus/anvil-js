import { bench, describe } from 'vitest';
import { compose } from '../src/kernel/middleware.js';
import { Context } from '../src/kernel/context.js';
import type { Middleware } from '../src/kernel/types.js';

const noop: Middleware = (_ctx, next) => next();
const handler = () => ({ ok: true });

function chain(depth: number) {
  return compose(Array.from({ length: depth }, () => noop), handler);
}

function ctx(): Context {
  return new Context(new Request('http://t.local/'));
}

describe('middleware onion overhead', () => {
  bench('no middleware (handler only)', async () => {
    await compose([], handler)(ctx());
  });

  bench('3 pass-through middleware', async () => {
    await chain(3)(ctx());
  });

  bench('10 pass-through middleware', async () => {
    await chain(10)(ctx());
  });

  bench('25 pass-through middleware', async () => {
    await chain(25)(ctx());
  });
});

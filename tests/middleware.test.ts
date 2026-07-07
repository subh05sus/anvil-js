import { describe, expect, it } from 'vitest';
import { Context } from '../src/kernel/context.js';
import { compose } from '../src/kernel/middleware.js';
import type { Middleware } from '../src/kernel/types.js';
import { req } from './helpers.js';

const ctx = () => new Context(req('GET', '/'));

describe('compose', () => {
  it('runs middleware outermost-first around the handler (onion order)', async () => {
    const order: string[] = [];
    const mw = (name: string): Middleware => async (_ctx, next) => {
      order.push(`${name}:before`);
      const res = await next();
      order.push(`${name}:after`);
      return res;
    };
    const run = compose([mw('outer'), mw('inner')], () => {
      order.push('handler');
      return 'ok';
    });
    await run(ctx());
    expect(order).toEqual(['outer:before', 'inner:before', 'handler', 'inner:after', 'outer:after']);
  });

  it('lets middleware short-circuit without calling the handler', async () => {
    let handlerRan = false;
    const run = compose(
      [async () => new Response('blocked', { status: 403 })],
      () => {
        handlerRan = true;
        return 'ok';
      },
    );
    const res = await run(ctx());
    expect(res.status).toBe(403);
    expect(handlerRan).toBe(false);
  });

  it('normalizes non-Response middleware returns', async () => {
    const run = compose([async () => ({ shortCircuit: true })], () => 'unreached');
    const res = await run(ctx());
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ shortCircuit: true });
  });

  it('throws when next() is called twice', async () => {
    const run = compose(
      [
        async (_ctx, next) => {
          await next();
          return next();
        },
      ],
      () => 'ok',
    );
    await expect(run(ctx())).rejects.toThrow(/next\(\) called multiple times/);
  });
});

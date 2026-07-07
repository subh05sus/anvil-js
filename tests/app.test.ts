import { describe, expect, it } from 'vitest';
import { createApp } from '../src/kernel/app.js';
import { HttpError } from '../src/kernel/errors.js';
import type { Middleware } from '../src/kernel/types.js';
import { req, route } from './helpers.js';

describe('createApp', () => {
  it('serves a route returning a plain object as JSON', async () => {
    const app = createApp({ routes: [route('GET', '/hello', () => ({ hi: true }))] });
    const res = await app.fetch(req('GET', '/hello'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hi: true });
  });

  it('returns JSON 404 for unknown paths', async () => {
    const app = createApp({ routes: [route('GET', '/hello')] });
    const res = await app.fetch(req('GET', '/nope'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ status: 404 });
  });

  it('returns 405 with an Allow header for wrong methods', async () => {
    const app = createApp({ routes: [route('GET', '/only-get')] });
    const res = await app.fetch(req('POST', '/only-get'));
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  it('answers OPTIONS automatically with the Allow header', async () => {
    const app = createApp({ routes: [route('GET', '/thing'), route('POST', '/thing')] });
    const res = await app.fetch(req('OPTIONS', '/thing'));
    expect(res.status).toBe(204);
    expect(res.headers.get('allow')).toBe('GET, HEAD, OPTIONS, POST');
  });

  it('serves HEAD from the GET handler with no body', async () => {
    const app = createApp({ routes: [route('GET', '/page', () => 'body text')] });
    const res = await app.fetch(req('HEAD', '/page'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('exposes route params on ctx', async () => {
    const app = createApp({ routes: [route('GET', '/users/[id]', (ctx) => ({ id: ctx.params.id }))] });
    const res = await app.fetch(req('GET', '/users/42'));
    expect(await res.json()).toEqual({ id: '42' });
  });

  it('runs route middleware around the handler', async () => {
    const tag: Middleware = async (_ctx, next) => {
      const res = await next();
      res.headers.set('x-tag', 'mw');
      return res;
    };
    const app = createApp({
      routes: [route('GET', '/tagged', () => 'ok', { middleware: [tag] })],
    });
    const res = await app.fetch(req('GET', '/tagged'));
    expect(res.headers.get('x-tag')).toBe('mw');
  });

  it('converts thrown HttpError into a matching response', async () => {
    const app = createApp({
      routes: [
        route('GET', '/teapot', () => {
          throw new HttpError(418, 'short and stout');
        }),
      ],
    });
    const res = await app.fetch(req('GET', '/teapot'));
    expect(res.status).toBe(418);
    expect(await res.json()).toMatchObject({ error: 'short and stout' });
  });

  it('hides 5xx details unless dev mode', async () => {
    const boom = route('GET', '/boom', () => {
      throw new Error('secret internals');
    });
    const prod = createApp({ routes: [boom] }, { dev: false });
    const prodRes = await prod.fetch(req('GET', '/boom'));
    expect(prodRes.status).toBe(500);
    expect(JSON.stringify(await prodRes.json())).not.toContain('secret internals');

    const dev = createApp({ routes: [boom] }, { dev: true });
    const devRes = await dev.fetch(req('GET', '/boom'));
    expect(JSON.stringify(await devRes.json())).toContain('secret internals');
  });

  it('uses a custom onError handler when provided', async () => {
    const app = createApp(
      {
        routes: [
          route('GET', '/boom', () => {
            throw new Error('x');
          }),
        ],
      },
      { onError: () => new Response('custom', { status: 599 }) },
    );
    const res = await app.fetch(req('GET', '/boom'));
    expect(res.status).toBe(599);
    expect(await res.text()).toBe('custom');
  });

  it('runs fallbackMiddleware for unmatched paths', async () => {
    const fallback: Middleware = async (ctx, next) => {
      if (ctx.path === '/intercepted') return new Response('from fallback');
      return next();
    };
    const app = createApp({ routes: [route('GET', '/real')], fallbackMiddleware: [fallback] });

    const intercepted = await app.fetch(req('GET', '/intercepted'));
    expect(await intercepted.text()).toBe('from fallback');

    const missed = await app.fetch(req('GET', '/still-missing'));
    expect(missed.status).toBe(404);
  });

  it('runs global middleware for both matched and unmatched paths', async () => {
    const stamp: Middleware = async (_ctx, next) => {
      const res = await next();
      res.headers.set('x-global', '1');
      return res;
    };
    const app = createApp({ routes: [route('GET', '/real')] }, { middleware: [stamp] });
    expect((await app.fetch(req('GET', '/real'))).headers.get('x-global')).toBe('1');
    expect((await app.fetch(req('GET', '/missing'))).headers.get('x-global')).toBe('1');
  });
});

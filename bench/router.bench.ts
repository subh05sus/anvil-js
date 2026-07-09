import express from 'express';
import FindMyWay from 'find-my-way';
import { bench, describe } from 'vitest';
import { Router } from '../src/kernel/router.js';
import { route } from '../tests/helpers.js';

/**
 * Route matching throughput: Anvil's radix-tree `Router` vs `find-my-way`
 * (the router Fastify itself uses internally) vs Express's `Router`. Same
 * route set, same lookups, run outside any HTTP layer so this isolates
 * matching cost specifically rather than framework overhead end-to-end.
 *
 * Express exposes no public "just match, don't dispatch" API, so its case
 * drives `router.handle(req, res, next)` against a minimal fake req/res —
 * an approximation, not a byte-for-byte comparison, but representative of
 * matching + handler-dispatch cost for a like-for-like route table.
 */
const ROUTES = [
  '/',
  '/users',
  '/users/[id]',
  '/users/[id]/posts',
  '/users/[id]/posts/[postId]',
  '/posts',
  '/posts/[id]',
  '/files/[...path]',
  '/settings',
  '/settings/profile',
];

const LOOKUPS = ['/', '/users', '/users/42', '/users/42/posts', '/users/42/posts/7', '/files/a/b/c', '/settings/profile'];

const anvilRouter = new Router(ROUTES.map((pattern) => route('GET', pattern)));

const fmw = FindMyWay();
for (const pattern of ROUTES) fmw.on('GET', toFindMyWayStyle(pattern), () => {});

const expressRouter = express.Router();
for (const pattern of ROUTES) expressRouter.get(toExpressStyle(pattern), (_req, res) => res.end());

// Express 5 (path-to-regexp v7) requires a named wildcard: `*splat`, not bare `*`.
function toExpressStyle(pattern: string): string {
  return pattern.replace(/\[\.\.\.(\w+)\]/g, '*$1').replace(/\[(\w+)\]/g, ':$1');
}

// find-my-way's wildcard syntax is a bare trailing `*` (no name).
function toFindMyWayStyle(pattern: string): string {
  return pattern.replace(/\[\.\.\.(\w+)\]/g, '*').replace(/\[(\w+)\]/g, ':$1');
}

function fakeExpressReqRes(path: string): { req: object; res: object } {
  return {
    req: { method: 'GET', url: path, originalUrl: path, headers: {} },
    res: {
      end() {},
      setHeader() {},
      getHeader() {},
      writeHead() {},
    },
  };
}

describe('route matching throughput', () => {
  bench('anvil Router.match', () => {
    for (const path of LOOKUPS) anvilRouter.match('GET', path);
  });

  bench('find-my-way .find (Fastify\'s router)', () => {
    for (const path of LOOKUPS) fmw.find('GET', path);
  });

  bench('express Router.handle (approximate)', () => {
    for (const path of LOOKUPS) {
      const { req, res } = fakeExpressReqRes(path);
      expressRouter.handle(req, res, () => {});
    }
  });
});

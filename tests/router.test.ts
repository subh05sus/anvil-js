import { describe, expect, it } from 'vitest';
import { Router } from '../src/kernel/router.js';
import { route } from './helpers.js';

describe('Router', () => {
  it('matches the root route', () => {
    const router = new Router([route('GET', '/')]);
    const match = router.match('GET', '/');
    expect(match && 'route' in match && match.route.pattern).toBe('/');
  });

  it('prefers static segments over params', () => {
    const router = new Router([route('GET', '/users/new'), route('GET', '/users/[id]')]);
    const match = router.match('GET', '/users/new');
    expect(match && 'route' in match && match.route.pattern).toBe('/users/new');
  });

  it('falls back to params for non-static values', () => {
    const router = new Router([route('GET', '/users/new'), route('GET', '/users/[id]')]);
    const match = router.match('GET', '/users/42');
    expect(match && 'route' in match && match.route.pattern).toBe('/users/[id]');
    expect(match && 'params' in match && match.params).toEqual({ id: '42' });
  });

  it('backtracks from a static dead-end into a param branch', () => {
    // /a/x exists as a static leaf, but /a/x/c only exists via /a/[b]/c.
    const router = new Router([route('GET', '/a/x'), route('GET', '/a/[b]/c')]);
    const match = router.match('GET', '/a/x/c');
    expect(match && 'route' in match && match.route.pattern).toBe('/a/[b]/c');
    expect(match && 'params' in match && match.params).toEqual({ b: 'x' });
  });

  it('matches catch-all segments and joins the rest', () => {
    const router = new Router([route('GET', '/files/[...path]')]);
    const match = router.match('GET', '/files/a/b/c.txt');
    expect(match && 'params' in match && match.params).toEqual({ path: 'a/b/c.txt' });
  });

  it('does not match a catch-all with zero segments', () => {
    const router = new Router([route('GET', '/files/[...path]')]);
    expect(router.match('GET', '/files')).toBeNull();
  });

  it('prefers param over catch-all for single segments', () => {
    const router = new Router([route('GET', '/f/[id]'), route('GET', '/f/[...rest]')]);
    const match = router.match('GET', '/f/one');
    expect(match && 'route' in match && match.route.pattern).toBe('/f/[id]');
    const multi = router.match('GET', '/f/one/two');
    expect(multi && 'route' in multi && multi.route.pattern).toBe('/f/[...rest]');
  });

  it('decodes URL-encoded params', () => {
    const router = new Router([route('GET', '/users/[name]')]);
    const match = router.match('GET', '/users/j%C3%B6rn');
    expect(match && 'params' in match && match.params).toEqual({ name: 'jörn' });
  });

  it('ignores trailing slashes', () => {
    const router = new Router([route('GET', '/users')]);
    const match = router.match('GET', '/users/');
    expect(match && 'route' in match).toBe(true);
  });

  it('returns allowed methods when the path exists but the method does not', () => {
    const router = new Router([route('GET', '/users'), route('POST', '/users')]);
    const match = router.match('DELETE', '/users');
    expect(match && 'allowed' in match && match.allowed).toEqual(['GET', 'HEAD', 'OPTIONS', 'POST']);
  });

  it('serves HEAD from a GET route when no head handler exists', () => {
    const router = new Router([route('GET', '/users')]);
    const match = router.match('HEAD', '/users');
    expect(match && 'route' in match && match.route.method).toBe('GET');
  });

  it('returns null for unknown paths', () => {
    const router = new Router([route('GET', '/users')]);
    expect(router.match('GET', '/nope')).toBeNull();
  });

  it('rejects duplicate routes', () => {
    expect(() => new Router([route('GET', '/users'), route('GET', '/users')])).toThrow(/Duplicate route/);
  });

  it('rejects conflicting param names at the same position', () => {
    expect(() => new Router([route('GET', '/u/[id]'), route('POST', '/u/[slug]')])).toThrow(
      /Conflicting dynamic segments/,
    );
  });
});

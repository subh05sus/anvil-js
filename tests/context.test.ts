import { describe, expect, it } from 'vitest';
import { Context, toResponse } from '../src/kernel/context.js';
import { HttpError } from '../src/kernel/errors.js';
import { req } from './helpers.js';

describe('Context', () => {
  it('parses query strings, collecting repeated keys into arrays', () => {
    const ctx = new Context(req('GET', '/search?q=anvil&tag=a&tag=b'));
    expect(ctx.query).toEqual({ q: 'anvil', tag: ['a', 'b'] });
  });

  it('parses JSON bodies and caches the result', async () => {
    const ctx = new Context(
      req('POST', '/x', { body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } }),
    );
    expect(await ctx.body()).toEqual({ a: 1 });
    // Second call must not re-read the consumed stream.
    expect(await ctx.body()).toEqual({ a: 1 });
  });

  it('throws HttpError(400) for malformed JSON', async () => {
    const ctx = new Context(
      req('POST', '/x', { body: '{nope', headers: { 'content-type': 'application/json' } }),
    );
    await expect(ctx.body()).rejects.toThrowError(HttpError);
    await expect(ctx.body()).rejects.toMatchObject({ status: 400 });
  });

  it('parses urlencoded bodies as FormData', async () => {
    const ctx = new Context(
      req('POST', '/x', { body: 'a=1&b=2', headers: { 'content-type': 'application/x-www-form-urlencoded' } }),
    );
    const form = await ctx.body<FormData>();
    expect(form.get('a')).toBe('1');
    expect(form.get('b')).toBe('2');
  });

  it('falls back to text for unknown content types', async () => {
    const ctx = new Context(req('POST', '/x', { body: 'plain', headers: { 'content-type': 'text/csv' } }));
    expect(await ctx.body()).toBe('plain');
  });

  it('exposes params, path, and method', () => {
    const ctx = new Context(req('PUT', '/users/7'), { id: '7' });
    expect(ctx.params.id).toBe('7');
    expect(ctx.path).toBe('/users/7');
    expect(ctx.method).toBe('PUT');
  });

  it('builds responses via helpers', async () => {
    const ctx = new Context(req('GET', '/'));
    expect(ctx.json({ ok: true }).headers.get('content-type')).toContain('application/json');
    expect(ctx.text('hi').headers.get('content-type')).toContain('text/plain');
    expect(ctx.html('<p>hi</p>').headers.get('content-type')).toContain('text/html');
    const redirect = ctx.redirect('/next');
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('/next');
  });
});

describe('toResponse', () => {
  it('passes Response through untouched', () => {
    const res = new Response('x', { status: 418 });
    expect(toResponse(res)).toBe(res);
  });

  it('serializes objects to JSON', async () => {
    const res = toResponse({ a: 1 });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('serializes strings to text/plain', async () => {
    const res = toResponse('hello');
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe('hello');
  });

  it('turns null/undefined into 204', () => {
    expect(toResponse(null).status).toBe(204);
    expect(toResponse(undefined).status).toBe(204);
  });
});

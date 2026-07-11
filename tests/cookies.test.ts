import { describe, expect, it } from 'vitest';
import { parseCookies, serializeCookie, signValue, unsignValue } from '../src/kernel/cookies.js';

describe('parseCookies', () => {
  it('parses name=value pairs and decodes values', () => {
    expect(parseCookies('a=1; b=hello%20world; c="quoted"')).toEqual({ a: '1', b: 'hello world', c: 'quoted' });
  });
  it('returns {} for null/empty', () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
});

describe('serializeCookie', () => {
  it('serializes attributes', () => {
    const s = serializeCookie('sid', 'abc', { httpOnly: true, sameSite: 'Lax', maxAge: 60, path: '/x' });
    expect(s).toContain('sid=abc');
    expect(s).toContain('Path=/x');
    expect(s).toContain('Max-Age=60');
    expect(s).toContain('SameSite=Lax');
    expect(s).toContain('HttpOnly');
  });
  it('SameSite=None forces Secure', () => {
    expect(serializeCookie('sid', 'abc', { sameSite: 'None' })).toContain('Secure');
  });
});

describe('sign/unsign', () => {
  it('round-trips a valid signature', () => {
    const signed = signValue('session-1', 's3cret');
    expect(unsignValue(signed, 's3cret')).toBe('session-1');
  });
  it('rejects a tampered value', () => {
    const signed = signValue('session-1', 's3cret');
    expect(unsignValue(signed.replace('session-1', 'session-2'), 's3cret')).toBeNull();
    expect(unsignValue('no-dot', 's3cret')).toBeNull();
  });
  it('accepts a rotated secret', () => {
    const signed = signValue('session-1', 'old');
    expect(unsignValue(signed, ['new', 'old'])).toBe('session-1');
    expect(unsignValue(signed, ['new'])).toBeNull();
  });
});

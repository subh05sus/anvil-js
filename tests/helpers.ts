import type { Handler, HttpMethod, RouteDefinition, Segment } from '../src/kernel/types.js';

/** Parse a `/users/[id]` style pattern into segments (test helper). */
export function parsePattern(pattern: string): Segment[] {
  if (pattern === '/') return [];
  return pattern
    .split('/')
    .filter(Boolean)
    .map((part): Segment => {
      if (part.startsWith('[...') && part.endsWith(']')) return { type: 'catchall', name: part.slice(4, -1) };
      if (part.startsWith('[') && part.endsWith(']')) return { type: 'param', name: part.slice(1, -1) };
      return { type: 'static', value: part };
    });
}

export function route(
  method: HttpMethod,
  pattern: string,
  handler?: Handler,
  overrides?: Partial<RouteDefinition>,
): RouteDefinition {
  return {
    method,
    pattern,
    segments: parsePattern(pattern),
    handler: handler ?? (() => ({ matched: pattern })),
    middleware: [],
    ...overrides,
  };
}

export function req(method: string, path: string, init?: RequestInit): Request {
  return new Request(`http://test.local${path}`, { method, ...init });
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/kernel/app.js';
import { cors } from '../src/kernel/cors.js';
import { serveStatic } from '../src/kernel/static.js';
import { req, route } from './helpers.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'public');

describe('serveStatic', () => {
  const app = createApp({ routes: [], fallbackMiddleware: [serveStatic({ dir: publicDir })] });

  it('serves files with the right content type', async () => {
    const res = await app.fetch(req('GET', '/hello.txt'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('hello from static');
  });

  it('serves index.html for directory requests', async () => {
    const res = await app.fetch(req('GET', '/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('falls through to 404 for missing files', async () => {
    expect((await app.fetch(req('GET', '/missing.txt'))).status).toBe(404);
  });

  it('blocks path traversal', async () => {
    const res = await app.fetch(req('GET', '/%2e%2e/%2e%2e/package.json'));
    expect(res.status).toBe(404);
  });

  it('skips non-GET methods', async () => {
    expect((await app.fetch(req('POST', '/hello.txt'))).status).toBe(404);
  });
});

describe('cors', () => {
  it('answers preflight requests', async () => {
    const app = createApp({ routes: [route('POST', '/api')] }, { middleware: [cors()] });
    const res = await app.fetch(
      req('OPTIONS', '/api', {
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('decorates simple responses with allow-origin', async () => {
    const app = createApp({ routes: [route('GET', '/api', () => ({ ok: 1 }))] }, { middleware: [cors()] });
    const res = await app.fetch(req('GET', '/api', { headers: { origin: 'https://example.com' } }));
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('restricts origins when a list is given', async () => {
    const app = createApp(
      { routes: [route('GET', '/api', () => ({ ok: 1 }))] },
      { middleware: [cors({ origin: ['https://allowed.dev'] })] },
    );
    const allowed = await app.fetch(req('GET', '/api', { headers: { origin: 'https://allowed.dev' } }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://allowed.dev');
    const denied = await app.fetch(req('GET', '/api', { headers: { origin: 'https://evil.dev' } }));
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});

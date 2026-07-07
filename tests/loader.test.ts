import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { describe, expect, it } from 'vitest';
import { loadManifest } from '../src/compiler/loader.js';
import { createApp } from '../src/kernel/app.js';
import { req } from './helpers.js';

const loaderFixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'loader');

// Vite intercepts dynamic import() inside vitest and percent-encodes `[id]`
// segments into unresolvable specifiers. Import through jiti instead — the
// same importer `anvil dev` uses.
const jiti = createJiti(import.meta.url, { interopDefault: false });
const nativeImporter = (file: string) => jiti.import(file);

describe('loadManifest', () => {
  it('imports handlers, meta, and middleware into a runnable manifest', async () => {
    const manifest = await loadManifest(loaderFixture, nativeImporter);

    const home = manifest.routes.find((r) => r.pattern === '/')!;
    expect(home.meta).toEqual({ mcp: { expose: true, description: 'home' } });
    expect(manifest.fallbackMiddleware).toHaveLength(1);

    const app = createApp(manifest);

    const homeRes = await app.fetch(req('GET', '/'));
    expect(await homeRes.json()).toEqual({ home: true });
    expect(homeRes.headers.get('x-root-mw')).toBe('1'); // root middleware on the route chain

    const userRes = await app.fetch(req('GET', '/users/9'));
    expect(await userRes.json()).toEqual({ id: '9' });

    // Root middleware also decorates the 404 fallback path.
    const missing = await app.fetch(req('GET', '/missing'));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-root-mw')).toBe('1');
  });
});

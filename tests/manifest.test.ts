import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { generateManifest } from '../src/compiler/manifest.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('generateManifest', () => {
  it('emits a static manifest with imports for every route and middleware', async () => {
    // Inside the repo, not os.tmpdir(): a temp dir on a different drive would
    // force absolute import specifiers and mask the relative-path behavior.
    const dir = await mkdtemp(path.join(fixtures, '..', '.tmp-manifest-'));
    tempDirs.push(dir);
    const outFile = path.join(dir, 'routes.ts');

    const { routeCount } = await generateManifest({ routesDir: path.join(fixtures, 'basic'), outFile });
    expect(routeCount).toBe(6);

    const code = await readFile(outFile, 'utf8');
    // POSIX import specifiers even on Windows.
    expect(code).not.toContain('\\');
    expect(code).toContain(`pattern: "/users/[id]"`);
    expect(code).toContain(`method: 'GET'`);
    expect(code).toContain('fallbackMiddleware: flat(');
    expect(code).toContain(`from 'anvil-js'`);
    // Each route imported as a namespace so meta comes along.
    expect(code).toMatch(/import \* as r\d+ from '\.\.?\/.*get\.ts'/);
  });
});

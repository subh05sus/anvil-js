import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scanRoutes } from '../src/compiler/scanner.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string) => path.join(fixtures, name);

describe('scanRoutes', () => {
  it('scans nested, dynamic, catch-all, and grouped routes', async () => {
    const { routes, rootMiddlewareFile } = await scanRoutes(fixture('basic'));
    const table = routes.map((r) => `${r.method} ${r.pattern}`).sort();
    expect(table).toEqual([
      'GET /',
      'GET /dashboard', // (admin) group stripped from the URL
      'GET /files/[...path]',
      'GET /users',
      'GET /users/[id]',
      'POST /users',
    ]);
    expect(rootMiddlewareFile).toMatch(/_middleware\.ts$/);
  });

  it('collects middleware root → leaf', async () => {
    const { routes } = await scanRoutes(fixture('basic'));
    const userById = routes.find((r) => r.pattern === '/users/[id]')!;
    expect(userById.middlewareFiles.map((f) => path.relative(fixture('basic'), f).split(path.sep).join('/'))).toEqual([
      '_middleware.ts',
      'users/_middleware.ts',
    ]);
    const home = routes.find((r) => r.pattern === '/')!;
    expect(home.middlewareFiles).toHaveLength(1);
  });

  it('parses segments with correct types', async () => {
    const { routes } = await scanRoutes(fixture('basic'));
    const catchall = routes.find((r) => r.pattern === '/files/[...path]')!;
    expect(catchall.segments).toEqual([
      { type: 'static', value: 'files' },
      { type: 'catchall', name: 'path' },
    ]);
  });

  it('rejects conflicting dynamic names at the same position ([id] vs [slug])', async () => {
    await expect(scanRoutes(fixture('conflict-dynamic'))).rejects.toThrow(/Conflicting dynamic segments/);
  });

  it('rejects the same route defined through two different groups', async () => {
    await expect(scanRoutes(fixture('conflict-group'))).rejects.toThrow(/Route conflict/);
  });

  it('rejects case-insensitive collisions (Windows vs Linux filesystem divergence)', async () => {
    await expect(scanRoutes(fixture('conflict-casing'))).rejects.toThrow(/Case-insensitive collision/);
  });

  it('rejects subdirectories inside catch-all directories', async () => {
    await expect(scanRoutes(fixture('catchall-subdir'))).rejects.toThrow(/cannot contain subdirectories/);
  });

  it('rejects duplicate param names within one route path', async () => {
    await expect(scanRoutes(fixture('dup-param'))).rejects.toThrow(/Duplicate dynamic parameter/);
  });
});

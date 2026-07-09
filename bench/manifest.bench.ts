import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { bench, describe } from 'vitest';
import { scanRoutes } from '../src/compiler/scanner.js';
import { loadManifest } from '../src/compiler/loader.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'basic');
const jiti = createJiti(import.meta.url, { interopDefault: false });
const importer = (file: string) => jiti.import(file);

describe('cold manifest load', () => {
  bench('scanRoutes (filesystem walk + validation only)', async () => {
    await scanRoutes(fixture);
  });

  bench('loadManifest (scan + import every handler/middleware) — anvil dev\'s per-reload cost', async () => {
    await loadManifest(fixture, importer);
  });
});

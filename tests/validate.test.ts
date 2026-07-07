import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { describe, expect, it } from 'vitest';
import { validateRoutes, type Diagnostic } from '../src/compiler/validate.js';

const validateDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'validate');

// jiti importer bypasses Vite's `[id]` specifier mangling (see loader.test.ts).
const jiti = createJiti(import.meta.url, { interopDefault: false });
const importer = (file: string) => jiti.import(file);

const forRoute = (diags: Diagnostic[], route: string) => diags.filter((d) => d.route === route);

describe('validateRoutes', () => {
  it('reports the full diagnostic set for a mixed routes tree', async () => {
    const { diagnostics, errorCount, warningCount } = await validateRoutes(validateDir, importer);

    // The good route produces nothing.
    expect(forRoute(diagnostics, 'GET /ok/[id]')).toEqual([]);

    // Param name mismatch → missing "id" + extra "userId".
    const mismatch = forRoute(diagnostics, 'GET /mismatch/[id]');
    const rules = mismatch.map((d) => d.rule).sort();
    expect(rules).toEqual(['params-extra', 'params-missing']);
    expect(mismatch.every((d) => d.level === 'error')).toBe(true);

    // Lossy MCP schema → not-serializable error mentioning bodySchema.
    const lossy = forRoute(diagnostics, 'GET /lossy/[id]');
    expect(lossy).toHaveLength(1);
    expect(lossy[0]!.rule).toBe('mcp-schema-not-serializable');
    expect(lossy[0]!.message).toContain('bodySchema');
    expect(lossy[0]!.message).toContain('transform');

    // MCP-exposed without a description → single warning.
    const nodesc = forRoute(diagnostics, 'GET /nodesc');
    expect(nodesc).toHaveLength(1);
    expect(nodesc[0]!.level).toBe('warning');
    expect(nodesc[0]!.rule).toBe('mcp-missing-description');

    expect(errorCount).toBe(3);
    expect(warningCount).toBe(1);
  });

  it('surfaces scanner conflicts as a single structural error', async () => {
    const conflictDir = path.join(validateDir, '..', 'conflict-casing');
    const { diagnostics, errorCount } = await validateRoutes(conflictDir, importer);
    expect(errorCount).toBe(1);
    expect(diagnostics[0]!.rule).toBe('route-structure');
    expect(diagnostics[0]!.message).toMatch(/Case-insensitive collision/);
  });
});

import { describe, expect, it } from 'vitest';
import { runSandboxed } from '../src/sandbox/index.js';

describe('runSandboxed', () => {
  it('returns the completion value of the code', async () => {
    const r = await runSandboxed('const a = 6; const b = 7; a * b');
    expect(r.ok).toBe(true);
    expect(r.value).toBe(42);
  });

  it('captures console.log output', async () => {
    const r = await runSandboxed('console.log("hello"); console.log("world"); 1');
    expect(r.logs).toEqual(['hello', 'world']);
  });

  it('exposes provided read-only globals', async () => {
    const r = await runSandboxed('input.x + input.y', { globals: { input: { x: 2, y: 3 } } });
    expect(r.value).toBe(5);
  });

  it('denies require / module access', async () => {
    const r = await runSandboxed('require("node:fs")');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/require is not defined/);
  });

  it('denies process access', async () => {
    const r = await runSandboxed('process.exit(1)');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/process is not defined/);
  });

  it('terminates code that exceeds the timeout', async () => {
    const r = await runSandboxed('while (true) {}', { timeoutMs: 200 });
    expect(r.ok).toBe(false);
    // vm timeout or worker terminate — either way it does not hang.
    expect(r.error).toBeTruthy();
  }, 5000);

  it('reports runtime errors from the code', async () => {
    const r = await runSandboxed('throw new Error("boom")');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
  });
});

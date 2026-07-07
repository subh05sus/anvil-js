import { describe, expect, it } from 'vitest';
import { PromptRegistry, renderPrompt } from '../src/prompt/index.js';
import { MemoryStateStore } from '../src/store/index.js';

describe('renderPrompt', () => {
  it('substitutes {{vars}} and blanks missing ones', () => {
    expect(renderPrompt('Hi {{name}}, you have {{count}} messages', { name: 'Ada', count: 3 })).toBe('Hi Ada, you have 3 messages');
    expect(renderPrompt('Hello {{ missing }}!')).toBe('Hello !');
  });
});

describe('PromptRegistry', () => {
  it('appends immutable versions and returns latest by default', async () => {
    const reg = new PromptRegistry(new MemoryStateStore());
    const v1 = await reg.register('greeting', 'Hello.', 'initial');
    const v2 = await reg.register('greeting', 'Hello there.');
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect((await reg.get('greeting'))?.template).toBe('Hello there.');
    expect((await reg.get('greeting', 1))?.template).toBe('Hello.');
    expect((await reg.list('greeting')).map((v) => v.version)).toEqual([1, 2]);
    expect(await reg.names()).toEqual(['greeting']);
  });

  it('diffs two versions line by line', async () => {
    const reg = new PromptRegistry(new MemoryStateStore());
    await reg.register('sys', 'You are helpful.\nBe concise.');
    await reg.register('sys', 'You are helpful.\nBe thorough.\nCite sources.');
    const diff = await reg.diff('sys', 1, 2);
    expect(diff.removed).toEqual(['Be concise.']);
    expect(diff.added).toEqual(['Be thorough.', 'Cite sources.']);
  });

  it('returns undefined for unknown prompt and throws diffing a missing version', async () => {
    const reg = new PromptRegistry(new MemoryStateStore());
    expect(await reg.get('nope')).toBeUndefined();
    await reg.register('x', 'a');
    await expect(reg.diff('x', 1, 2)).rejects.toThrow(/missing version 2/);
  });
});

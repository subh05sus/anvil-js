import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemory, getMemory } from '../src/memory/index.js';
import { MemoryStateStore } from '../src/store/index.js';
import { createApp } from '../src/kernel/app.js';
import { req, route } from './helpers.js';

describe('MemoryStore', () => {
  it('gets/sets/appends/deletes namespaced values', async () => {
    const store = new MemoryStateStore();
    const mem = new MemoryStore(store, 'conv-1');
    await mem.set('name', 'Ada');
    expect(await mem.get('name')).toBe('Ada');
    expect(await mem.append('history', { role: 'user' })).toBe(1);
    expect(await mem.append('history', { role: 'assistant' })).toBe(2);
    expect(await mem.get('history')).toEqual([{ role: 'user' }, { role: 'assistant' }]);
    expect((await mem.keys()).sort()).toEqual(['history', 'name']);
    await mem.delete('name');
    expect(await mem.get('name')).toBeUndefined();
  });

  it('isolates namespaces', async () => {
    const store = new MemoryStateStore();
    await new MemoryStore(store, 'a').set('k', 1);
    expect(await new MemoryStore(store, 'b').get('k')).toBeUndefined();
  });
});

describe('withMemory middleware', () => {
  it('attaches a per-session MemoryStore keyed by x-session-id', async () => {
    const store = new MemoryStateStore();
    let seenNs: unknown;
    const app = createApp(
      {
        routes: [
          route('GET', '/whoami', async (ctx) => {
            const mem = getMemory(ctx)!;
            await mem.set('touched', true);
            seenNs = await mem.keys();
            return { ok: true };
          }),
        ],
      },
      { middleware: [withMemory(store)] },
    );
    await app.fetch(req('GET', '/whoami', { headers: { 'x-session-id': 's1' } }));
    expect(seenNs).toEqual(['touched']);
    // The value landed under the s1 namespace.
    expect(await new MemoryStore(store, 's1').get('touched')).toBe(true);
  });
});

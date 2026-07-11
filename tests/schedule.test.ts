import { describe, expect, it } from 'vitest';
import { Scheduler, TriggerRegistry, cronMatches, defineSchedule, defineTrigger } from '../src/schedule/index.js';
import { MemoryStateStore } from '../src/store/index.js';
import { MemoryTraceStore } from '../src/trace/memory-store.js';
import { Tracer } from '../src/trace/tracer.js';

// A fixed local time: 2026-07-08 09:30 (Wed).
const at = (h: number, m: number, opts: { date?: number; month?: number; year?: number } = {}) =>
  new Date(opts.year ?? 2026, (opts.month ?? 7) - 1, opts.date ?? 8, h, m, 0, 0);

describe('cronMatches', () => {
  it('matches wildcards, exact, steps, ranges, lists', () => {
    expect(cronMatches('* * * * *', at(9, 30))).toBe(true);
    expect(cronMatches('30 9 * * *', at(9, 30))).toBe(true);
    expect(cronMatches('30 9 * * *', at(9, 31))).toBe(false);
    expect(cronMatches('*/15 * * * *', at(9, 30))).toBe(true);
    expect(cronMatches('*/15 * * * *', at(9, 31))).toBe(false);
    expect(cronMatches('0 9-17 * * *', at(13, 0))).toBe(true);
    expect(cronMatches('0 9-17 * * *', at(18, 0))).toBe(false);
    expect(cronMatches('0 0 * * 1,3,5', at(0, 0, { date: 8 }))).toBe(true); // 2026-07-08 is a Wed (dow 3)
  });

  it('throws on malformed expressions', () => {
    expect(() => cronMatches('* * *', at(9, 30))).toThrow(/expected 5 fields/);
  });
});

describe('Scheduler', () => {
  it('runs due tasks once per minute and skips non-matching ones', async () => {
    const ran: string[] = [];
    const scheduler = new Scheduler()
      .add(defineSchedule({ name: 'hourly', cron: '0 * * * *', run: () => void ran.push('hourly') }))
      .add(defineSchedule({ name: 'at-930', cron: '30 9 * * *', run: () => void ran.push('at-930') }));

    expect(await scheduler.tick(at(9, 30))).toEqual(['at-930']);
    // Same minute again → dedup, nothing runs.
    expect(await scheduler.tick(at(9, 30))).toEqual([]);
    // Top of the hour → the hourly task.
    expect(await scheduler.tick(at(10, 0))).toEqual(['hourly']);
    expect(ran).toEqual(['at-930', 'hourly']);
  });

  it('does not re-fire across a restart when a store is shared', async () => {
    const store = new MemoryStateStore();
    const ran: string[] = [];
    const task = defineSchedule({ name: 'nightly', cron: '30 9 * * *', run: () => void ran.push('nightly') });

    const first = new Scheduler({ store }).add(task);
    expect(await first.tick(at(9, 30))).toEqual(['nightly']);

    // Simulate a process restart within the same minute: fresh Scheduler, same store.
    const second = new Scheduler({ store }).add(task);
    expect(await second.tick(at(9, 30))).toEqual([]);
    expect(ran).toEqual(['nightly']);
  });

  it('traces each run and isolates task failures', async () => {
    const store = new MemoryTraceStore();
    const errors: string[] = [];
    const scheduler = new Scheduler({ tracer: new Tracer(store), onError: (t) => errors.push(t) })
      .add(defineSchedule({ name: 'boom', cron: '* * * * *', run: () => { throw new Error('nope'); } }))
      .add(defineSchedule({ name: 'ok', cron: '* * * * *', run: () => undefined }));

    const ran = await scheduler.tick(at(9, 30));
    expect(ran.sort()).toEqual(['boom', 'ok']);
    expect(errors).toEqual(['boom']);
    const traces = store.listTraces();
    expect(traces.find((t) => t.name === 'schedule boom')?.status).toBe('error');
    expect(traces.find((t) => t.name === 'schedule ok')?.status).toBe('ok');
  });
});

describe('TriggerRegistry', () => {
  it('fires a registered trigger with its payload and returns the result', async () => {
    const seen: unknown[] = [];
    const registry = new TriggerRegistry().register(
      defineTrigger({ name: 'order.created', run: (ctx) => { seen.push(ctx.payload); return 'handled'; } }),
    );
    expect(registry.has('order.created')).toBe(true);
    const result = await registry.fire('order.created', { id: 'A-1' });
    expect(result).toBe('handled');
    expect(seen).toEqual([{ id: 'A-1' }]);
  });

  it('throws firing an unknown trigger', async () => {
    await expect(new TriggerRegistry().fire('nope')).rejects.toThrow(/No trigger registered/);
  });
});

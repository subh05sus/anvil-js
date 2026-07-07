import type { ListTracesOptions, Span, Trace, TraceStore } from './types.js';

/**
 * Zero-dependency in-memory trace store. The default for tests and keyless
 * local dev; swap in SqliteTraceStore for persistence across restarts.
 */
export class MemoryTraceStore implements TraceStore {
  #traces = new Map<string, Trace>();
  #spans = new Map<string, Span[]>();

  saveTrace(trace: Trace): void {
    // Merge any spans already recorded for this trace id.
    const spans = this.#spans.get(trace.id) ?? trace.spans;
    this.#traces.set(trace.id, { ...trace, spans });
  }

  saveSpan(span: Span): void {
    const list = this.#spans.get(span.traceId) ?? [];
    const existing = list.findIndex((s) => s.id === span.id);
    if (existing >= 0) list[existing] = span;
    else list.push(span);
    this.#spans.set(span.traceId, list);
    const trace = this.#traces.get(span.traceId);
    if (trace) trace.spans = list;
  }

  getTrace(id: string): Trace | undefined {
    const trace = this.#traces.get(id);
    if (!trace) return undefined;
    return { ...trace, spans: this.#spans.get(id) ?? trace.spans };
  }

  listTraces(opts: ListTracesOptions = {}): Trace[] {
    const all = [...this.#traces.values()].sort((a, b) => b.startedAt - a.startedAt);
    const offset = opts.offset ?? 0;
    return all.slice(offset, opts.limit ? offset + opts.limit : undefined).map((t) => this.getTrace(t.id)!);
  }

  clear(): void {
    this.#traces.clear();
    this.#spans.clear();
  }
}

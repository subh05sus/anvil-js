import { randomUUID } from 'node:crypto';
import type { Span, SpanKind, SpanStatus, Trace, TraceStore } from './types.js';

export interface TracerOptions {
  /** Called with the finished trace on trace end — the OTel-export seam (M4-B). */
  onExport?: (trace: Trace) => void;
}

/**
 * Builds trace trees and persists them (PRD §6.6). One `TraceHandle` per run;
 * spans nest via `parentId`. Model/tool/retrieval/cache/judge calls all flow
 * through here so the dashboard, OTel export, and cost governor read one tree.
 */
export class Tracer {
  #store: TraceStore;
  #onExport?: (trace: Trace) => void;

  constructor(store: TraceStore, options: TracerOptions = {}) {
    this.#store = store;
    this.#onExport = options.onExport;
  }

  start(name: string, attributes: Record<string, unknown> = {}): TraceHandle {
    return new TraceHandle(this.#store, this.#onExport, name, attributes);
  }
}

export class TraceHandle {
  readonly id = randomUUID();
  #store: TraceStore;
  #onExport?: (trace: Trace) => void;
  #trace: Trace;
  #spans: Span[] = [];

  constructor(
    store: TraceStore,
    onExport: ((trace: Trace) => void) | undefined,
    name: string,
    attributes: Record<string, unknown>,
  ) {
    this.#store = store;
    this.#onExport = onExport;
    this.#trace = {
      id: this.id,
      name,
      startedAt: Date.now(),
      status: 'running',
      spans: this.#spans,
      totalCostUsd: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      attributes,
    };
    void this.#store.saveTrace(this.#trace);
  }

  startSpan(name: string, kind: SpanKind, attributes: Record<string, unknown> = {}, parentId?: string): SpanHandle {
    const span: Span = {
      id: randomUUID(),
      traceId: this.id,
      parentId,
      name,
      kind,
      startedAt: Date.now(),
      status: 'running',
      attributes,
    };
    this.#spans.push(span);
    void this.#store.saveSpan(span);
    return new SpanHandle(span, this);
  }

  /** Roll a completed model span's usage/cost into the trace totals. */
  addUsage(usage: { inputTokens: number; outputTokens: number }, costUsd = 0): void {
    this.#trace.totalInputTokens += usage.inputTokens;
    this.#trace.totalOutputTokens += usage.outputTokens;
    this.#trace.totalCostUsd += costUsd;
  }

  /** @internal — a span handle reports its final state here for persistence. */
  _persistSpan(span: Span): void {
    void this.#store.saveSpan(span);
  }

  end(status: SpanStatus = 'ok'): Trace {
    this.#trace.endedAt = Date.now();
    this.#trace.status = status;
    void this.#store.saveTrace(this.#trace);
    this.#onExport?.(this.#trace);
    return this.#trace;
  }

  get trace(): Trace {
    return this.#trace;
  }
}

export class SpanHandle {
  #span: Span;
  #trace: TraceHandle;

  constructor(span: Span, trace: TraceHandle) {
    this.#span = span;
    this.#trace = trace;
  }

  get id(): string {
    return this.#span.id;
  }

  setAttributes(attributes: Record<string, unknown>): void {
    Object.assign(this.#span.attributes, attributes);
  }

  end(status: SpanStatus = 'ok', attributes: Record<string, unknown> = {}): void {
    Object.assign(this.#span.attributes, attributes);
    this.#span.status = status;
    this.#span.endedAt = Date.now();
    this.#trace._persistSpan(this.#span);
  }

  fail(error: unknown): void {
    this.#span.error = error instanceof Error ? error.message : String(error);
    this.end('error');
  }
}

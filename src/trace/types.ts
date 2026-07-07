export type SpanKind = 'agent' | 'model' | 'tool' | 'retrieval' | 'cache' | 'judge' | 'http';

export type SpanStatus = 'running' | 'ok' | 'error' | 'aborted';

/** One node in a trace tree — a model call, tool call, retrieval, etc. */
export interface Span {
  id: string;
  traceId: string;
  parentId?: string;
  name: string;
  kind: SpanKind;
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  /** Freeform: model, provider, usage, cost, tool args/result, etc. */
  attributes: Record<string, unknown>;
  error?: string;
}

/** A captured run — the span tree plus rolled-up token/cost totals (PRD §6.6). */
export interface Trace {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  status: SpanStatus;
  spans: Span[];
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  attributes: Record<string, unknown>;
}

export interface ListTracesOptions {
  limit?: number;
  offset?: number;
}

/**
 * Pluggable persistence for traces/spans (PRD §8 StoreAdapter). SQLite is the
 * production default; an in-memory store backs tests and keyless dev.
 */
export interface TraceStore {
  saveTrace(trace: Trace): void | Promise<void>;
  /** Insert or update a span (spans are written on end). */
  saveSpan(span: Span): void | Promise<void>;
  getTrace(id: string): (Trace | undefined) | Promise<Trace | undefined>;
  listTraces(opts?: ListTracesOptions): Trace[] | Promise<Trace[]>;
}

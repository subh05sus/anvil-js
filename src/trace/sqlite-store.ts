import type { ListTracesOptions, Span, Trace, TraceStore } from './types.js';

/** Minimal better-sqlite3 surface the store uses — lets it be lazy + typed. */
interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStmt;
}
interface SqliteStmt {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * SQLite-backed trace store (PRD default). `better-sqlite3` is loaded lazily —
 * an optional peer dependency — so pure-REST users and CI without native build
 * tooling aren't forced to install it. Full trace/span JSON lives in a `data`
 * column; indexed columns support the dashboard's list/rollup queries.
 */
export class SqliteTraceStore implements TraceStore {
  #db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.#db = db;
    this.#db.exec(SCHEMA);
  }

  /** Open (or create) a database file. Pass ':memory:' for an ephemeral store. */
  static async open(filename = '.anvil/traces.db'): Promise<SqliteTraceStore> {
    let Database: new (file: string) => SqliteDb;
    try {
      const spec: string = 'better-sqlite3';
      const mod = (await import(spec)) as { default: typeof Database };
      Database = mod.default;
    } catch {
      throw new Error("SqliteTraceStore requires 'better-sqlite3'. Install it, or use MemoryTraceStore.");
    }
    return new SqliteTraceStore(new Database(filename));
  }

  /** Build directly from an already-constructed better-sqlite3 instance. */
  static fromDb(db: SqliteDb): SqliteTraceStore {
    return new SqliteTraceStore(db);
  }

  saveTrace(trace: Trace): void {
    this.#db
      .prepare(
        `INSERT INTO traces (id, name, started_at, ended_at, status, total_cost_usd, total_input_tokens, total_output_tokens, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, ended_at=excluded.ended_at, status=excluded.status,
           total_cost_usd=excluded.total_cost_usd, total_input_tokens=excluded.total_input_tokens,
           total_output_tokens=excluded.total_output_tokens, data=excluded.data`,
      )
      .run(
        trace.id,
        trace.name,
        trace.startedAt,
        trace.endedAt ?? null,
        trace.status,
        trace.totalCostUsd,
        trace.totalInputTokens,
        trace.totalOutputTokens,
        JSON.stringify({ attributes: trace.attributes }),
      );
  }

  saveSpan(span: Span): void {
    this.#db
      .prepare(
        `INSERT INTO spans (id, trace_id, parent_id, name, kind, started_at, ended_at, status, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, status=excluded.status, data=excluded.data`,
      )
      .run(
        span.id,
        span.traceId,
        span.parentId ?? null,
        span.name,
        span.kind,
        span.startedAt,
        span.endedAt ?? null,
        span.status,
        JSON.stringify({ attributes: span.attributes, error: span.error }),
      );
  }

  getTrace(id: string): Trace | undefined {
    const row = this.#db.prepare(`SELECT * FROM traces WHERE id = ?`).get(id) as TraceRow | undefined;
    if (!row) return undefined;
    const spanRows = this.#db.prepare(`SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at ASC`).all(id) as SpanRow[];
    return rowToTrace(row, spanRows);
  }

  listTraces(opts: ListTracesOptions = {}): Trace[] {
    const rows = this.#db
      .prepare(`SELECT * FROM traces ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(opts.limit ?? 100, opts.offset ?? 0) as TraceRow[];
    return rows.map((r) => this.getTrace(r.id)!);
  }
}

interface TraceRow {
  id: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  data: string;
}
interface SpanRow {
  id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  started_at: number;
  ended_at: number | null;
  status: string;
  data: string;
}

function rowToTrace(row: TraceRow, spanRows: SpanRow[]): Trace {
  const meta = JSON.parse(row.data) as { attributes?: Record<string, unknown> };
  return {
    id: row.id,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    status: row.status as Trace['status'],
    totalCostUsd: row.total_cost_usd,
    totalInputTokens: row.total_input_tokens,
    totalOutputTokens: row.total_output_tokens,
    attributes: meta.attributes ?? {},
    spans: spanRows.map(rowToSpan),
  };
}

function rowToSpan(row: SpanRow): Span {
  const meta = JSON.parse(row.data) as { attributes?: Record<string, unknown>; error?: string };
  return {
    id: row.id,
    traceId: row.trace_id,
    parentId: row.parent_id ?? undefined,
    name: row.name,
    kind: row.kind as Span['kind'],
    startedAt: row.started_at,
    endedAt: row.ended_at ?? undefined,
    status: row.status as Span['status'],
    attributes: meta.attributes ?? {},
    error: meta.error,
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
  id TEXT PRIMARY KEY, name TEXT, started_at INTEGER, ended_at INTEGER, status TEXT,
  total_cost_usd REAL, total_input_tokens INTEGER, total_output_tokens INTEGER, data TEXT
);
CREATE TABLE IF NOT EXISTS spans (
  id TEXT PRIMARY KEY, trace_id TEXT, parent_id TEXT, name TEXT, kind TEXT,
  started_at INTEGER, ended_at INTEGER, status TEXT, data TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_traces_started ON traces(started_at DESC);
`;

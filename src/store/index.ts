/**
 * Pluggable key/value state store (PRD §8) — backs HITL suspended runs,
 * durable checkpoints (§6.20), and the memory store (§6.10). SQLite is the
 * production default; MemoryStateStore backs tests and keyless dev.
 */
export interface StateStore {
  get<T>(key: string): (T | undefined) | Promise<T | undefined>;
  set(key: string, value: unknown): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  /** Keys, optionally filtered by prefix. */
  list(prefix?: string): string[] | Promise<string[]>;
}

/** Zero-dependency in-memory store. Values are structured-cloned on set to avoid aliasing. */
export class MemoryStateStore implements StateStore {
  #map = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    const v = this.#map.get(key);
    return v === undefined ? undefined : (clone(v) as T);
  }

  set(key: string, value: unknown): void {
    this.#map.set(key, clone(value));
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  list(prefix?: string): string[] {
    const keys = [...this.#map.keys()];
    return prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
  }

  clear(): void {
    this.#map.clear();
  }
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
}

/**
 * SQLite-backed state store. `better-sqlite3` loads lazily (optional peer dep),
 * so it never blocks pure-REST users or CI without native build tooling.
 */
export class SqliteStateStore implements StateStore {
  #db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.#db = db;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);
  }

  static async open(filename = '.anvil/state.db'): Promise<SqliteStateStore> {
    let Database: new (file: string) => SqliteDb;
    try {
      const spec: string = 'better-sqlite3';
      const mod = (await import(spec)) as { default: typeof Database };
      Database = mod.default;
    } catch {
      throw new Error("SqliteStateStore requires 'better-sqlite3'. Install it, or use MemoryStateStore.");
    }
    return new SqliteStateStore(new Database(filename));
  }

  static fromDb(db: SqliteDb): SqliteStateStore {
    return new SqliteStateStore(db);
  }

  get<T>(key: string): T | undefined {
    const row = this.#db.prepare(`SELECT value FROM kv WHERE key = ?`).get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  set(key: string, value: unknown): void {
    this.#db
      .prepare(`INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(value), Date.now());
  }

  delete(key: string): void {
    this.#db.prepare(`DELETE FROM kv WHERE key = ?`).run(key);
  }

  list(prefix?: string): string[] {
    const rows = prefix
      ? (this.#db.prepare(`SELECT key FROM kv WHERE key LIKE ? ORDER BY key`).all(prefix + '%') as { key: string }[])
      : (this.#db.prepare(`SELECT key FROM kv ORDER BY key`).all() as { key: string }[]);
    return rows.map((r) => r.key);
  }
}

export const MODULE_STATUS = 'active' as const;

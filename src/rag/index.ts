import type { TraceHandle } from '../trace/tracer.js';

// ── Embedders ───────────────────────────────────────────────────────

/** Turns text into vectors. Provider embedders (OpenAI/Gemini) implement this too. */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic, dependency-free embedder (hashed bag-of-tokens). Not
 * semantic, but zero-config for tests and local dev — cosine similarity
 * tracks shared vocabulary. Swap in a provider embedder for real retrieval.
 */
export class HashEmbedder implements Embedder {
  readonly dimensions: number;

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.#embedOne(t));
  }

  #embedOne(text: string): number[] {
    const vec = new Array<number>(this.dimensions).fill(0);
    for (const token of tokenize(text)) {
      const idx = hash(token) % this.dimensions;
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    return normalize(vec);
  }
}

// ── Vector stores ───────────────────────────────────────────────────

export interface VectorRecord {
  id: string;
  text: string;
  embedding: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorQueryResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  add(records: VectorRecord[]): void | Promise<void>;
  query(embedding: number[], topK: number): VectorQueryResult[] | Promise<VectorQueryResult[]>;
  size(): number | Promise<number>;
}

/** In-memory vector store with brute-force cosine similarity (default). */
export class MemoryVectorStore implements VectorStore {
  #records: VectorRecord[] = [];

  add(records: VectorRecord[]): void {
    this.#records.push(...records);
  }

  query(embedding: number[], topK: number): VectorQueryResult[] {
    return this.#records
      .map((r) => ({ id: r.id, text: r.text, score: cosine(embedding, r.embedding), metadata: r.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  size(): number {
    return this.#records.length;
  }

  clear(): void {
    this.#records = [];
  }
}

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
}

/**
 * SQLite-backed vector store (persistent). `better-sqlite3` loads lazily as an
 * optional peer dep. Embeddings stored as JSON; similarity is brute-force
 * cosine in JS — fine for the small/medium corpora typical of app-embedded RAG.
 * (A `sqlite-vec` ANN adapter can slot in behind this same interface.)
 */
export class SqliteVectorStore implements VectorStore {
  #db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.#db = db;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, text TEXT, embedding TEXT, metadata TEXT)`);
  }

  static async open(filename = '.anvil/vectors.db'): Promise<SqliteVectorStore> {
    let Database: new (file: string) => SqliteDb;
    try {
      const spec: string = 'better-sqlite3';
      const mod = (await import(spec)) as { default: typeof Database };
      Database = mod.default;
    } catch {
      throw new Error("SqliteVectorStore requires 'better-sqlite3'. Install it, or use MemoryVectorStore.");
    }
    return new SqliteVectorStore(new Database(filename));
  }

  add(records: VectorRecord[]): void {
    const stmt = this.#db.prepare(
      `INSERT INTO vectors (id, text, embedding, metadata) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text, embedding=excluded.embedding, metadata=excluded.metadata`,
    );
    for (const r of records) stmt.run(r.id, r.text, JSON.stringify(r.embedding), r.metadata ? JSON.stringify(r.metadata) : null);
  }

  query(embedding: number[], topK: number): VectorQueryResult[] {
    const rows = this.#db.prepare(`SELECT id, text, embedding, metadata FROM vectors`).all() as Array<{
      id: string;
      text: string;
      embedding: string;
      metadata: string | null;
    }>;
    return rows
      .map((r) => ({
        id: r.id,
        text: r.text,
        score: cosine(embedding, JSON.parse(r.embedding) as number[]),
        metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  size(): number {
    return (this.#db.prepare(`SELECT COUNT(*) as n FROM vectors`).all()[0] as { n: number }).n;
  }
}

// ── Chunking ────────────────────────────────────────────────────────

export interface ChunkOptions {
  /** Max characters per chunk. Default 800. */
  size?: number;
  /** Overlap characters between consecutive chunks. Default 100. */
  overlap?: number;
}

/** Split text into overlapping chunks, preferring paragraph/sentence boundaries. */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? 800;
  const overlap = Math.min(options.overlap ?? 100, size - 1);
  const trimmed = text.trim();
  if (trimmed.length <= size) return trimmed ? [trimmed] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < trimmed.length) {
    let end = Math.min(start + size, trimmed.length);
    if (end < trimmed.length) {
      // Back off to the nearest boundary within the last ~20% of the window.
      const window = trimmed.slice(start, end);
      const boundary = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
      if (boundary > size * 0.5) end = start + boundary + 1;
    }
    chunks.push(trimmed.slice(start, end).trim());
    if (end >= trimmed.length) break;
    start = end - overlap;
  }
  return chunks.filter(Boolean);
}

// ── Retriever ───────────────────────────────────────────────────────

export interface RetrieverOptions {
  embedder: Embedder;
  store: VectorStore;
  chunk?: ChunkOptions;
}

export interface IndexDoc {
  id?: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface RetrieveOptions {
  topK?: number;
  /** Record a retrieval span on this trace (PRD §6.6 — shows in the dashboard). */
  trace?: TraceHandle;
  /** Parent span id for the retrieval span. */
  parentSpanId?: string;
}

/**
 * RAG pipeline primitive (PRD §6.22): chunk + embed + index documents, then
 * retrieve the most similar chunks for a query. Retrieval is traced so "why
 * did the agent say that" is answerable from the dashboard.
 */
export class Retriever {
  #embedder: Embedder;
  #store: VectorStore;
  #chunk?: ChunkOptions;

  constructor(options: RetrieverOptions) {
    this.#embedder = options.embedder;
    this.#store = options.store;
    this.#chunk = options.chunk;
  }

  /** Chunk, embed, and index documents. Returns the number of chunks added. */
  async index(docs: IndexDoc[]): Promise<number> {
    const records: VectorRecord[] = [];
    const pending: Array<{ id: string; text: string; metadata?: Record<string, unknown> }> = [];
    for (const [i, doc] of docs.entries()) {
      const docId = doc.id ?? `doc-${i}`;
      const chunks = chunkText(doc.text, this.#chunk);
      chunks.forEach((text, ci) => pending.push({ id: `${docId}#${ci}`, text, metadata: doc.metadata }));
    }
    if (pending.length === 0) return 0;
    const embeddings = await this.#embedder.embed(pending.map((p) => p.text));
    pending.forEach((p, i) => records.push({ id: p.id, text: p.text, embedding: embeddings[i]!, metadata: p.metadata }));
    await this.#store.add(records);
    return records.length;
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<VectorQueryResult[]> {
    const topK = options.topK ?? 4;
    const span = options.trace?.startSpan('retrieve', 'retrieval', { query, topK }, options.parentSpanId);
    try {
      const [embedding] = await this.#embedder.embed([query]);
      const results = await this.#store.query(embedding!, topK);
      span?.end('ok', { results: results.length, topScore: results[0]?.score });
      return results;
    } catch (err) {
      span?.fail(err);
      throw err;
    }
  }
}

// ── Semantic cache ──────────────────────────────────────────────────

export interface SemanticCacheOptions {
  embedder: Embedder;
  /** Minimum cosine similarity to count as a hit. Default 0.95. */
  threshold?: number;
  /** Backing store for cached (embedding, response) pairs. Default in-memory. */
  store?: VectorStore;
  /** Entry lifetime in ms. Default: no expiry. */
  ttlMs?: number;
}

export interface CacheLookup {
  hit: boolean;
  value?: string;
  score?: number;
}

/**
 * Response cache keyed on embedding similarity rather than exact string match
 * (PRD §6.11) — for expensive/repeated LLM calls. Cache hits/misses are
 * recorded as trace spans so hit rate is visible in the dashboard.
 */
export class SemanticCache {
  #embedder: Embedder;
  #threshold: number;
  #store: VectorStore;
  #ttlMs?: number;
  #counter = 0;

  constructor(options: SemanticCacheOptions) {
    this.#embedder = options.embedder;
    this.#threshold = options.threshold ?? 0.95;
    this.#store = options.store ?? new MemoryVectorStore();
    this.#ttlMs = options.ttlMs;
  }

  async get(prompt: string, opts: { trace?: TraceHandle; parentSpanId?: string; now?: number } = {}): Promise<CacheLookup> {
    const span = opts.trace?.startSpan('cache', 'cache', { threshold: this.#threshold }, opts.parentSpanId);
    const [embedding] = await this.#embedder.embed([prompt]);
    const [top] = await this.#store.query(embedding!, 1);
    const now = opts.now ?? Date.now();
    const fresh = top && (this.#ttlMs === undefined || now - Number(top.metadata?.at ?? 0) <= this.#ttlMs);
    const hit = !!top && fresh && top.score >= this.#threshold;
    span?.end('ok', { hit, score: top?.score });
    return hit ? { hit: true, value: top.text, score: top.score } : { hit: false, score: top?.score };
  }

  async set(prompt: string, value: string, now = Date.now()): Promise<void> {
    const [embedding] = await this.#embedder.embed([prompt]);
    await this.#store.add([{ id: `cache-${this.#counter++}`, text: value, embedding: embedding!, metadata: { prompt, at: now } }]);
  }

  /** Return the cached response for `prompt`, or run `produce`, cache it, and return it. */
  async wrap(
    prompt: string,
    produce: () => Promise<string>,
    opts: { trace?: TraceHandle; parentSpanId?: string } = {},
  ): Promise<{ value: string; cached: boolean }> {
    const found = await this.get(prompt, opts);
    if (found.hit) return { value: found.value!, cached: true };
    const value = await produce();
    await this.set(prompt, value);
    return { value, cached: false };
  }
}

// ── math/util ───────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalize(vec: number[]): number[] {
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return mag === 0 ? vec : vec.map((v) => v / mag);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let ma = 0;
  let mb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    ma += a[i]! * a[i]!;
    mb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(ma) * Math.sqrt(mb);
  return denom === 0 ? 0 : dot / denom;
}

export const MODULE_STATUS = 'active' as const;

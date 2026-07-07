# Memory & retrieval

## Session memory

```ts
import { withMemory, getMemory } from 'anvil/memory';
// root _middleware.ts:
export default [withMemory(stateStore)]; // namespaced per x-session-id header by default

// in a handler:
const mem = getMemory(ctx)!;
await mem.append('history', { role: 'user', text: '...' });
const history = await mem.get('history');
```

Typed `get`/`set`/`append`/`delete`/`keys` over the pluggable state store — no hand-rolled per-project memory table.

## RAG

```ts
import { HashEmbedder, MemoryVectorStore, Retriever, chunkText } from 'anvil/rag';

const retriever = new Retriever({ embedder: new HashEmbedder(), store: new MemoryVectorStore() });
await retriever.index([{ id: 'faq', text: '...long document...' }]); // chunked + embedded automatically
const results = await retriever.retrieve('how do refunds work?', { topK: 4, trace }); // recorded as a retrieval span
```

`HashEmbedder` is a zero-dependency, deterministic bag-of-tokens embedder — good for tests and local dev, not semantically strong. Swap in a provider embedder (OpenAI, Gemini, etc. — implement the one-method `Embedder` interface) for real retrieval quality. `MemoryVectorStore` does brute-force cosine similarity; `SqliteVectorStore` persists to disk (optional `better-sqlite3` peer dependency) — both implement the same `VectorStore` interface, so a `sqlite-vec`-backed ANN adapter can slot in later without touching call sites.

Wire retrieval into an agent via the [context assembly pipeline](./agents.md#context-assembly):

```ts
import { retrievalContext } from 'anvil/agent';
export default defineAgent({ client, context: [retrievalContext(retriever, { topK: 4 })] });
```

## Semantic cache

```ts
import { SemanticCache } from 'anvil/rag';

const cache = new SemanticCache({ embedder: new HashEmbedder(), threshold: 0.95, ttlMs: 60_000 });
const { value, cached } = await cache.wrap(prompt, () => expensiveLlmCall(prompt), { trace });
```

Keyed on embedding cosine similarity rather than exact string match, so near-duplicate prompts still hit. Each lookup records a `cache` trace span with the hit flag, so hit rate is visible in the [dashboard](./observability.md).

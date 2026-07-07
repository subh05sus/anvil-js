import { describe, expect, it } from 'vitest';
import {
  HashEmbedder,
  MemoryVectorStore,
  Retriever,
  chunkText,
  cosine,
} from '../src/rag/index.js';
import { MemoryTraceStore } from '../src/trace/memory-store.js';
import { Tracer } from '../src/trace/tracer.js';

describe('chunkText', () => {
  it('returns a single chunk for short text', () => {
    expect(chunkText('hello world')).toEqual(['hello world']);
    expect(chunkText('')).toEqual([]);
  });

  it('splits long text into overlapping chunks preferring boundaries', () => {
    const para = 'a'.repeat(500) + '.\n\n' + 'b'.repeat(500) + '.\n\n' + 'c'.repeat(500);
    const chunks = chunkText(para, { size: 600, overlap: 50 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 600)).toBe(true);
  });
});

describe('HashEmbedder + cosine', () => {
  it('embeds to unit vectors and scores overlapping text higher', async () => {
    const e = new HashEmbedder(128);
    const [cat, cat2, dog] = await e.embed(['the cat sat on the mat', 'a cat on a mat', 'quantum chromodynamics']);
    expect(cosine(cat!, cat2!)).toBeGreaterThan(cosine(cat!, dog!));
  });
});

describe('Retriever', () => {
  const docs = [
    { id: 'faq', text: 'Our return policy allows refunds within 30 days of purchase with a receipt.' },
    { id: 'ship', text: 'Standard shipping takes 5 to 7 business days. Express shipping is overnight.' },
    { id: 'hours', text: 'The support desk is open Monday to Friday, 9am to 5pm Pacific time.' },
  ];

  it('indexes docs and retrieves the most relevant chunk', async () => {
    const retriever = new Retriever({ embedder: new HashEmbedder(256), store: new MemoryVectorStore() });
    const n = await retriever.index(docs);
    expect(n).toBeGreaterThanOrEqual(3);

    const results = await retriever.retrieve('how long do I have to return something for a refund?', { topK: 1 });
    expect(results[0]!.id).toMatch(/^faq/);
    expect(results[0]!.text).toContain('refunds');
  });

  it('records a retrieval span on the trace', async () => {
    const store = new MemoryTraceStore();
    const trace = new Tracer(store).start('rag');
    const retriever = new Retriever({ embedder: new HashEmbedder(128), store: new MemoryVectorStore() });
    await retriever.index(docs);
    await retriever.retrieve('shipping time?', { topK: 2, trace });
    trace.end('ok');

    const span = store.getTrace(trace.id)!.spans.find((s) => s.kind === 'retrieval')!;
    expect(span.name).toBe('retrieve');
    expect(span.attributes.topK).toBe(2);
    expect(span.attributes.results).toBe(2);
  });
});

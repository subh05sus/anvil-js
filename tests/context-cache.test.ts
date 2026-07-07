import { describe, expect, it } from 'vitest';
import { HashEmbedder, MemoryVectorStore, Retriever, SemanticCache } from '../src/rag/index.js';
import {
  assembleContext,
  lastUserText,
  retrievalContext,
  systemContext,
  tokenBudget,
} from '../src/agent/context.js';
import { MemoryTraceStore } from '../src/trace/memory-store.js';
import { Tracer } from '../src/trace/tracer.js';
import type { ModelMessage } from '../src/llm/types.js';

describe('SemanticCache', () => {
  it('misses, stores, then hits a near-identical prompt', async () => {
    const cache = new SemanticCache({ embedder: new HashEmbedder(256), threshold: 0.8 });
    let produced = 0;
    const produce = async () => {
      produced++;
      return 'the answer is 42';
    };

    const first = await cache.wrap('what is the meaning of life', produce);
    expect(first).toEqual({ value: 'the answer is 42', cached: false });

    const second = await cache.wrap('what is the meaning of life really', produce);
    expect(second.cached).toBe(true);
    expect(second.value).toBe('the answer is 42');
    expect(produced).toBe(1); // produce ran only once
  });

  it('misses an unrelated prompt', async () => {
    const cache = new SemanticCache({ embedder: new HashEmbedder(256), threshold: 0.9 });
    await cache.set('how do I reset my password', 'click forgot password');
    const res = await cache.get('what is the capital of France');
    expect(res.hit).toBe(false);
  });

  it('records a cache span with the hit flag', async () => {
    const store = new MemoryTraceStore();
    const trace = new Tracer(store).start('cached');
    const cache = new SemanticCache({ embedder: new HashEmbedder(128), threshold: 0.8 });
    await cache.set('ping', 'pong');
    await cache.get('ping', { trace });
    trace.end('ok');
    const span = store.getTrace(trace.id)!.spans.find((s) => s.kind === 'cache')!;
    expect(span.attributes.hit).toBe(true);
  });

  it('respects TTL expiry', async () => {
    const cache = new SemanticCache({ embedder: new HashEmbedder(128), threshold: 0.5, ttlMs: 1000 });
    await cache.set('q', 'a', 1000);
    expect((await cache.get('q', { now: 1500 })).hit).toBe(true);
    expect((await cache.get('q', { now: 3000 })).hit).toBe(false);
  });
});

describe('context assembly', () => {
  const convo: ModelMessage[] = [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'what is your return policy?' },
  ];

  it('lastUserText reads the most recent user message', () => {
    expect(lastUserText(convo)).toBe('what is your return policy?');
  });

  it('injects retrieved chunks into the system prompt', async () => {
    const retriever = new Retriever({ embedder: new HashEmbedder(256), store: new MemoryVectorStore() });
    await retriever.index([{ id: 'faq', text: 'Our return policy allows refunds within 30 days.' }]);
    const assembled = await assembleContext(
      { messages: convo, query: lastUserText(convo), system: 'You are support.' },
      [retrievalContext(retriever, { topK: 1 })],
    );
    expect(assembled.system).toContain('You are support.');
    expect(assembled.system).toContain('Relevant context');
    expect(assembled.system).toContain('refunds within 30 days');
  });

  it('trims oldest messages to fit the token budget', async () => {
    const big: ModelMessage[] = [
      { role: 'user', content: 'x'.repeat(4000) },
      { role: 'assistant', content: 'y'.repeat(4000) },
      { role: 'user', content: 'keep me' },
    ];
    const assembled = await assembleContext({ messages: big, query: 'keep me' }, [tokenBudget({ maxTokens: 100 })]);
    expect(assembled.messages.at(-1)!.content).toBe('keep me');
    expect(assembled.messages.length).toBeLessThan(3);
  });

  it('composes multiple steps (system + retrieval)', async () => {
    const retriever = new Retriever({ embedder: new HashEmbedder(128), store: new MemoryVectorStore() });
    await retriever.index([{ text: 'shipping takes 5-7 days' }]);
    const assembled = await assembleContext({ messages: convo, query: 'shipping?' }, [
      systemContext('Be concise.'),
      retrievalContext(retriever, { topK: 1 }),
    ]);
    expect(assembled.system).toContain('Be concise.');
    expect(assembled.system).toContain('shipping');
  });
});

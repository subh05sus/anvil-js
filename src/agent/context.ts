import type { ModelMessage } from '../llm/types.js';
import type { TraceHandle } from '../trace/tracer.js';
import type { Retriever } from '../rag/index.js';

export interface ContextInput {
  messages: ModelMessage[];
  system?: string;
  /** The query to assemble context around — defaults to the last user message. */
  query: string;
  trace?: TraceHandle;
}

/** A step returns fragments to merge: system additions and messages to prepend. */
export interface ContextPatch {
  systemAppend?: string;
  prependMessages?: ModelMessage[];
  /** Replace the working messages entirely (e.g. after trimming). */
  messages?: ModelMessage[];
}

export interface ContextStep {
  name: string;
  apply(input: ContextInput): ContextPatch | Promise<ContextPatch>;
}

export interface AssembledContext {
  messages: ModelMessage[];
  system?: string;
}

/**
 * Context assembly pipeline (PRD §6.8) — the `_context.ts` convention as a
 * composable chain: RAG retrieval, token-budget trimming, system-prompt
 * injection. Analogous to `_middleware.ts`, but for building the model input.
 */
export async function assembleContext(input: ContextInput, steps: ContextStep[]): Promise<AssembledContext> {
  let messages = [...input.messages];
  const systemParts = input.system ? [input.system] : [];
  const prepended: ModelMessage[] = [];

  for (const step of steps) {
    const patch = await step.apply({ ...input, messages });
    if (patch.messages) messages = patch.messages;
    if (patch.systemAppend) systemParts.push(patch.systemAppend);
    if (patch.prependMessages) prepended.push(...patch.prependMessages);
  }

  return {
    messages: [...prepended, ...messages],
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
  };
}

/** Extract the last user message's text — the default retrieval query. */
export function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    return m.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
  return '';
}

// ── Built-in steps ──────────────────────────────────────────────────

export interface RetrievalContextOptions {
  topK?: number;
  /** Render retrieved chunks into a system addendum. */
  template?: (chunks: string[]) => string;
}

/** Retrieve for the query and inject the chunks as a system addendum (RAG). */
export function retrievalContext(retriever: Retriever, options: RetrievalContextOptions = {}): ContextStep {
  const render = options.template ?? ((chunks) => `Relevant context:\n${chunks.map((c) => `- ${c}`).join('\n')}`);
  return {
    name: 'retrieval',
    async apply(input) {
      const results = await retriever.retrieve(input.query, { topK: options.topK ?? 4, trace: input.trace });
      if (results.length === 0) return {};
      return { systemAppend: render(results.map((r) => r.text)) };
    },
  };
}

/**
 * Trim oldest non-system messages so the estimated token count stays under
 * budget (~4 chars/token). Keeps the most recent turns.
 */
export function tokenBudget(options: { maxTokens: number }): ContextStep {
  return {
    name: 'token-budget',
    apply(input) {
      const limitChars = options.maxTokens * 4;
      const msgs = [...input.messages];
      let total = msgs.reduce((n, m) => n + estimateChars(m), 0);
      // Drop from the front (oldest) until within budget, keeping ≥ the last message.
      while (total > limitChars && msgs.length > 1) {
        total -= estimateChars(msgs.shift()!);
      }
      return { messages: msgs };
    },
  };
}

/** Inject a system prompt fragment (static or computed). */
export function systemContext(text: string): ContextStep {
  return { name: 'system', apply: () => ({ systemAppend: text }) };
}

function estimateChars(m: ModelMessage): number {
  return typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length;
}

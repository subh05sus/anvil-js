import type { Usage } from './types.js';

/** Price in USD per 1,000,000 tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  /** Cache-read price (≈0.1× input) if the provider bills it separately. */
  cacheRead?: number;
  /** Cache-write price (≈1.25× input for 5m TTL). */
  cacheWrite?: number;
}

// Anthropic list prices (per 1M tokens). Sourced from the claude-api skill's
// model table; update alongside model launches.
const PRICING = new Map<string, ModelPricing>([
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-opus-4-8', { input: 5, output: 25 }],
  ['claude-opus-4-7', { input: 5, output: 25 }],
  ['claude-opus-4-6', { input: 5, output: 25 }],
  ['claude-sonnet-5', { input: 3, output: 15 }],
  ['claude-sonnet-4-6', { input: 3, output: 15 }],
  ['claude-haiku-4-5', { input: 1, output: 5 }],
]);

/** Register or override pricing for a model (e.g. OpenAI models, or new releases). */
export function registerPricing(model: string, pricing: ModelPricing): void {
  PRICING.set(model, pricing);
}

export function getPricing(model: string): ModelPricing | undefined {
  return PRICING.get(model);
}

/**
 * Compute USD cost for a usage record. Returns undefined when the model's
 * price is unknown — callers should surface "cost unavailable" rather than 0.
 */
export function computeCost(model: string, usage: Usage): number | undefined {
  const p = PRICING.get(model);
  if (!p) return undefined;
  const million = 1_000_000;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cacheWrite = p.cacheWrite ?? p.input * 1.25;
  return (
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cacheReadTokens ?? 0) * cacheRead +
      (usage.cacheWriteTokens ?? 0) * cacheWrite) /
    million
  );
}

/**
 * Provider-agnostic model client (PRD §6.4) — lands in M3.
 * Thin driver abstraction over the official Anthropic/OpenAI SDKs with
 * fallback chains, retries, cost tracking, and abort propagation.
 */
export const MODULE_STATUS = 'planned:M3' as const;

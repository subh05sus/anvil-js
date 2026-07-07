import type { JsonSchema } from '../compiler/json-schema.js';

export type Role = 'system' | 'user' | 'assistant';

/** Structured message content — enables the tool-calling loop (assistant tool_use, user tool_result). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface ModelMessage {
  role: Role;
  /** Plain text, or structured blocks for tool calls/results. */
  content: string | ContentBlock[];
}

/** A tool advertised to the model. `inputSchema` is JSON Schema (from the M1 converter). */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

/** A tool invocation the model requested. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ResponseFormat {
  type: 'json_schema';
  schema: JsonSchema;
  name?: string;
}

export interface GenerateRequest {
  /** Model id, e.g. 'claude-opus-4-8'. Falls back to the client default. */
  model?: string;
  system?: string;
  messages: ModelMessage[];
  maxTokens?: number;
  /** Enable adaptive thinking (Claude) / reasoning. Off by default. */
  thinking?: boolean;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Propagated from a request/agent so a client disconnect aborts the model call. */
  signal?: AbortSignal;
  /** Ask the provider to emit JSON matching this schema (structured output). */
  responseFormat?: ResponseFormat;
  /** Tools the model may call. Presence enables tool-calling responses. */
  tools?: ToolSpec[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  provider: string;
  usage: Usage;
  /** USD cost from the pricing table; undefined if the model's price is unknown. */
  costUsd?: number;
  /** e.g. 'end_turn', 'tool_use', 'max_tokens'. */
  stopReason?: string;
  /** Tool calls the model requested this turn (when stopReason is 'tool_use'). */
  toolCalls?: ToolCall[];
  /** Provider-native response, for escape hatches. */
  raw?: unknown;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; result: GenerateResult };

/**
 * A provider adapter. Kept deliberately thin — one interface over the official
 * Anthropic/OpenAI SDKs (and a mock) so fallback, retries, cost, and tracing
 * live in one place (PRD §6.4).
 */
export interface ModelDriver {
  readonly provider: string;
  /** Whether this driver serves the given model id. */
  supports(model: string): boolean;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

/** Error drivers throw for transient failures the client should retry / fall back on. */
export class RetryableModelError extends Error {
  readonly status?: number;
  constructor(message: string, opts?: { status?: number; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.name = 'RetryableModelError';
    this.status = opts?.status;
  }
}

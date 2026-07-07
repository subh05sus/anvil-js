import type { z } from 'zod';
import { zodToJsonSchema } from '../compiler/json-schema.js';
import {
  RetryableModelError,
  type GenerateRequest,
  type GenerateResult,
  type ModelDriver,
  type StreamEvent,
} from './types.js';

export interface TraceEvent {
  kind: 'generate' | 'stream' | 'object';
  model: string;
  provider: string;
  attempt: number;
  /** True when this model was reached via the fallback chain, not the primary. */
  fallback: boolean;
  usage: GenerateResult['usage'];
  costUsd?: number;
  ok: boolean;
  error?: string;
}

export interface LlmClientOptions {
  drivers: ModelDriver[];
  /** Model used when a request omits one. */
  defaultModel?: string;
  /** Ordered models to try after the primary on transient failure. */
  fallback?: string[];
  /** Attempts per model before moving to the next (default 2). */
  maxRetries?: number;
  /** Base backoff in ms (default 50; multiplied per attempt). Set 0 in tests. */
  retryBaseMs?: number;
  /** Observability hook — every model call reports here (feeds M4 tracing). */
  onTrace?: (event: TraceEvent) => void;
}

export interface GenerateObjectResult<T> extends Omit<GenerateResult, 'text'> {
  object: T;
  /** Raw text the object was parsed from. */
  text: string;
}

/**
 * Provider-agnostic model client (PRD §6.4). Owns fallback chains, transient
 * retries, cost accumulation, and structured-output enforcement (§6.5) so
 * handlers just call `generate` / `generateObject`.
 */
export class LlmClient {
  #drivers: ModelDriver[];
  #defaultModel?: string;
  #fallback: string[];
  #maxRetries: number;
  #retryBaseMs: number;
  #onTrace?: (event: TraceEvent) => void;
  #totalCostUsd = 0;

  constructor(options: LlmClientOptions) {
    this.#drivers = options.drivers;
    this.#defaultModel = options.defaultModel;
    this.#fallback = options.fallback ?? [];
    this.#maxRetries = options.maxRetries ?? 2;
    this.#retryBaseMs = options.retryBaseMs ?? 50;
    this.#onTrace = options.onTrace;
  }

  /** Total USD across every call on this client (cost-governor input for M4). */
  get totalCostUsd(): number {
    return this.#totalCostUsd;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    return this.#withFallback('generate', req, (driver, r) => driver.generate(r));
  }

  /**
   * Enforce structured output: request JSON for the schema, validate with Zod,
   * and on failure re-prompt with the validation error (up to `maxRepairs`).
   */
  async generateObject<T>(
    req: GenerateRequest,
    schema: z.ZodType<T>,
    opts: { maxRepairs?: number; name?: string } = {},
  ): Promise<GenerateObjectResult<T>> {
    const maxRepairs = opts.maxRepairs ?? 2;
    const responseFormat = {
      type: 'json_schema' as const,
      name: opts.name,
      schema: safeJsonSchema(schema),
    };
    const messages = [...req.messages];
    let lastError = '';

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const result = await this.#withFallback('object', { ...req, messages, responseFormat }, (driver, r) =>
        driver.generate(r),
      );
      const parsed = tryParse(result.text);
      if (parsed.ok) {
        const validated = schema.safeParse(parsed.value);
        if (validated.success) {
          return { ...result, object: validated.data, text: result.text };
        }
        lastError = validated.error.message;
      } else {
        lastError = parsed.error;
      }
      // Feed the failure back for a repair attempt.
      messages.push({ role: 'assistant', content: result.text });
      messages.push({
        role: 'user',
        content: `That response did not match the required schema. Error:\n${lastError}\nReturn only valid JSON matching the schema.`,
      });
    }
    throw new Error(`generateObject failed to produce schema-valid output after ${maxRepairs + 1} attempts: ${lastError}`);
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const { model, driver, fallback } = this.#resolve(req.model);
    // Streaming does not retry mid-stream (bytes may already be sent); it falls
    // back only if the stream fails before yielding.
    let started = false;
    try {
      for await (const event of driver.stream({ ...req, model })) {
        started = true;
        if (event.type === 'done') {
          this.#totalCostUsd += event.result.costUsd ?? 0;
          this.#trace('stream', event.result, 1, fallback, true);
        }
        yield event;
      }
    } catch (err) {
      if (started) throw err;
      this.#trace('stream', { model, provider: driver.provider, usage: { inputTokens: 0, outputTokens: 0 } } as GenerateResult, 1, fallback, false, err);
      throw err;
    }
  }

  /** Resolve the ordered [primary, ...fallback] model chain and their drivers. */
  #chain(model?: string): string[] {
    const primary = model ?? this.#defaultModel;
    if (!primary) throw new Error('No model specified and no defaultModel configured on the LlmClient.');
    return [primary, ...this.#fallback.filter((m) => m !== primary)];
  }

  #driverFor(model: string): ModelDriver | undefined {
    return this.#drivers.find((d) => d.supports(model));
  }

  #resolve(model?: string): { model: string; driver: ModelDriver; fallback: boolean } {
    const chain = this.#chain(model);
    for (let i = 0; i < chain.length; i++) {
      const driver = this.#driverFor(chain[i]!);
      if (driver) return { model: chain[i]!, driver, fallback: i > 0 };
    }
    throw new Error(`No registered driver supports any of: ${chain.join(', ')}`);
  }

  async #withFallback(
    kind: TraceEvent['kind'],
    req: GenerateRequest,
    run: (driver: ModelDriver, req: GenerateRequest) => Promise<GenerateResult>,
  ): Promise<GenerateResult> {
    const chain = this.#chain(req.model);
    let lastError: unknown;

    for (let i = 0; i < chain.length; i++) {
      const model = chain[i]!;
      const driver = this.#driverFor(model);
      if (!driver) {
        lastError = new Error(`No driver for model "${model}"`);
        continue;
      }
      const isFallback = i > 0;
      for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
        try {
          const result = await run(driver, { ...req, model });
          this.#totalCostUsd += result.costUsd ?? 0;
          this.#trace(kind, result, attempt, isFallback, true);
          return result;
        } catch (err) {
          lastError = err;
          this.#trace(
            kind,
            { model, provider: driver.provider, usage: { inputTokens: 0, outputTokens: 0 } } as GenerateResult,
            attempt,
            isFallback,
            false,
            err,
          );
          if (!isRetryable(err) || attempt === this.#maxRetries) break;
          await delay(this.#retryBaseMs * attempt);
        }
      }
      // Move to the next model in the chain if the error was retryable/transient.
      if (!isRetryable(lastError)) break;
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  #trace(
    kind: TraceEvent['kind'],
    result: GenerateResult,
    attempt: number,
    fallback: boolean,
    ok: boolean,
    error?: unknown,
  ): void {
    this.#onTrace?.({
      kind,
      model: result.model,
      provider: result.provider,
      attempt,
      fallback,
      usage: result.usage,
      costUsd: result.costUsd,
      ok,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
    });
  }
}

function isRetryable(err: unknown): boolean {
  return err instanceof RetryableModelError;
}

function tryParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(stripFences(text)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Tolerate ```json fenced blocks some models wrap JSON in. */
function stripFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1]! : trimmed;
}

function safeJsonSchema(schema: z.ZodType): ReturnType<typeof zodToJsonSchema> {
  return zodToJsonSchema(schema as never);
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

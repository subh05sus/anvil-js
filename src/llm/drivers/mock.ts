import { computeCost } from '../cost.js';
import { RetryableModelError, type GenerateRequest, type GenerateResult, type ModelDriver, type StreamEvent } from '../types.js';

export interface MockResponse {
  /** Text to return. If a function, computed from the request. */
  text: string | ((req: GenerateRequest) => string);
  usage?: { inputTokens: number; outputTokens: number };
  /** Throw this instead of responding (to exercise retry/fallback). */
  error?: Error;
}

export interface MockDriverOptions {
  /** Model-id prefix this mock claims to serve. Default: 'mock'. */
  prefix?: string;
  provider?: string;
  /** Queue of scripted responses, consumed one per generate/stream call. */
  script?: MockResponse[];
  /** Default text when the script is exhausted. */
  defaultText?: string;
}

/**
 * Deterministic in-process driver for tests and keyless local dev. Scripts a
 * queue of responses (including errors, to exercise the client's retry and
 * fallback paths).
 */
export class MockDriver implements ModelDriver {
  readonly provider: string;
  #prefix: string;
  #script: MockResponse[];
  #defaultText: string;
  /** Records every request it received — handy for assertions. */
  readonly calls: GenerateRequest[] = [];

  constructor(options: MockDriverOptions = {}) {
    this.provider = options.provider ?? 'mock';
    this.#prefix = options.prefix ?? 'mock';
    this.#script = [...(options.script ?? [])];
    this.#defaultText = options.defaultText ?? 'ok';
  }

  supports(model: string): boolean {
    return model.startsWith(this.#prefix);
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    const next = this.#script.shift();
    if (next?.error) throw next.error;

    const text = next ? resolve(next.text, req) : this.#defaultText;
    const usage = next?.usage ?? { inputTokens: estimate(req), outputTokens: Math.ceil(text.length / 4) };
    const model = req.model ?? `${this.#prefix}-model`;
    return {
      text,
      model,
      provider: this.provider,
      usage,
      costUsd: computeCost(model, usage),
      stopReason: 'end_turn',
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const result = await this.generate(req);
    // Emit the text in a few chunks so streaming consumers exercise chunk handling.
    for (const chunk of chunk3(result.text)) {
      yield { type: 'text', text: chunk };
    }
    yield { type: 'done', result };
  }
}

/** Convenience: a mock that always throws a retryable error N times, then succeeds. */
export function flakyScript(failures: number, text = 'recovered'): MockResponse[] {
  return [
    ...Array.from({ length: failures }, () => ({ text: '', error: new RetryableModelError('transient') })),
    { text },
  ];
}

function resolve(text: string | ((req: GenerateRequest) => string), req: GenerateRequest): string {
  return typeof text === 'function' ? text(req) : text;
}

function estimate(req: GenerateRequest): number {
  const chars = (req.system?.length ?? 0) + req.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 4);
}

function chunk3(text: string): string[] {
  if (text.length === 0) return [''];
  const size = Math.max(1, Math.ceil(text.length / 3));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

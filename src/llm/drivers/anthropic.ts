import { computeCost } from '../cost.js';
import {
  RetryableModelError,
  type ContentBlock,
  type GenerateRequest,
  type GenerateResult,
  type ModelDriver,
  type ModelMessage,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from '../types.js';

/** Minimal surface of `@anthropic-ai/sdk` the driver depends on — lets tests inject a fake. */
export interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<AnthropicMessage>;
  };
}

interface AnthropicMessage {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicDriverOptions {
  apiKey?: string;
  /** Default model when a request omits one. */
  defaultModel?: string;
  /** Inject a client (for tests); otherwise the official SDK is loaded lazily. */
  client?: AnthropicLike;
}

/**
 * Anthropic driver — a thin adapter over `@anthropic-ai/sdk`, loaded lazily so
 * the kernel and pure-REST users never pull it in. Follows the claude-api skill:
 * top-level `system`, adaptive thinking opt-in, `output_config.format` for
 * structured output (never assistant prefill).
 */
export class AnthropicDriver implements ModelDriver {
  readonly provider = 'anthropic';
  #options: AnthropicDriverOptions;
  #client?: AnthropicLike;

  constructor(options: AnthropicDriverOptions = {}) {
    this.#options = options;
    this.#client = options.client;
  }

  supports(model: string): boolean {
    return model.startsWith('claude');
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = await this.#getClient();
    const model = req.model ?? this.#options.defaultModel ?? 'claude-opus-4-8';
    try {
      const res = await client.messages.create(buildParams(req, model), { signal: req.signal });
      return toResult(res, model, this.provider);
    } catch (err) {
      throw classify(err);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    // M3-A: non-streaming under the hood; true token streaming lands with agent
    // routes in M3-B. The event shape is already the streaming contract.
    const result = await this.generate(req);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }

  async #getClient(): Promise<AnthropicLike> {
    if (this.#client) return this.#client;
    let Anthropic: new (opts: { apiKey?: string }) => AnthropicLike;
    try {
      // Widened specifier: keeps the SDK an optional runtime dep (no compile-time resolution).
      const spec: string = '@anthropic-ai/sdk';
      const mod = (await import(spec)) as { default: typeof Anthropic };
      Anthropic = mod.default;
    } catch {
      throw new Error(
        "AnthropicDriver requires '@anthropic-ai/sdk'. Install it, or inject a client via { client }.",
      );
    }
    this.#client = new Anthropic({ apiKey: this.#options.apiKey });
    return this.#client;
  }
}

function buildParams(req: GenerateRequest, model: string): Record<string, unknown> {
  // Any 'system' messages are lifted into the top-level system field.
  const systemParts = req.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''));
  const system = [req.system, ...systemParts].filter(Boolean).join('\n\n') || undefined;
  const messages = req.messages.filter((m) => m.role !== 'system').map(toAnthropicMessage);

  const params: Record<string, unknown> = {
    model,
    max_tokens: req.maxTokens ?? 4096,
    messages,
  };
  if (system) params.system = system;
  if (req.thinking) params.thinking = { type: 'adaptive' };
  if (req.effort) params.output_config = { ...(params.output_config as object), effort: req.effort };
  if (req.responseFormat) {
    params.output_config = {
      ...(params.output_config as object),
      format: { type: 'json_schema', schema: req.responseFormat.schema },
    };
  }
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  return params;
}

function toAnthropicMessage(m: ModelMessage): { role: string; content: unknown } {
  if (typeof m.content === 'string') return { role: m.role, content: m.content };
  const blocks = m.content.map((b: ContentBlock) => {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      case 'tool_result':
        return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
    }
  });
  return { role: m.role, content: blocks };
}

function toResult(res: AnthropicMessage, model: string, provider: string): GenerateResult {
  const text = res.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  const toolCalls: ToolCall[] = res.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id ?? '', name: b.name ?? '', input: b.input }));
  const usage: Usage = {
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    cacheReadTokens: res.usage?.cache_read_input_tokens,
    cacheWriteTokens: res.usage?.cache_creation_input_tokens,
  };
  return {
    text,
    model,
    provider,
    usage,
    costUsd: computeCost(model, usage),
    stopReason: res.stop_reason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    raw: res,
  };
}

function classify(err: unknown): Error {
  const status = (err as { status?: number })?.status;
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
    return new RetryableModelError(`Anthropic request failed (${status})`, { status, cause: err });
  }
  const name = (err as { name?: string })?.name;
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') {
    return new RetryableModelError('Anthropic connection error', { cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

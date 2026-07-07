import { computeCost } from '../cost.js';
import {
  RetryableModelError,
  type GenerateRequest,
  type GenerateResult,
  type ModelDriver,
  type ModelMessage,
  type StreamEvent,
  type ToolCall,
  type Usage,
} from '../types.js';

/** Minimal surface of the `openai` SDK the driver depends on — lets tests inject a fake. */
export interface OpenAILike {
  chat: {
    completions: {
      create(params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<OpenAICompletion>;
    };
  };
}

interface OpenAICompletion {
  choices: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAIDriverOptions {
  apiKey?: string;
  defaultModel?: string;
  client?: OpenAILike;
}

/**
 * OpenAI driver — thin adapter over the `openai` SDK (Chat Completions),
 * loaded lazily. Pricing for OpenAI models is not seeded by default; register
 * it via `registerPricing(...)` if you want cost figures.
 */
export class OpenAIDriver implements ModelDriver {
  readonly provider = 'openai';
  #options: OpenAIDriverOptions;
  #client?: OpenAILike;

  constructor(options: OpenAIDriverOptions = {}) {
    this.#options = options;
    this.#client = options.client;
  }

  supports(model: string): boolean {
    return model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4');
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = await this.#getClient();
    const model = req.model ?? this.#options.defaultModel ?? 'gpt-4o';
    try {
      const res = await client.chat.completions.create(buildParams(req, model), { signal: req.signal });
      return toResult(res, model, this.provider);
    } catch (err) {
      throw classify(err);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    const result = await this.generate(req);
    yield { type: 'text', text: result.text };
    yield { type: 'done', result };
  }

  async #getClient(): Promise<OpenAILike> {
    if (this.#client) return this.#client;
    let OpenAI: new (opts: { apiKey?: string }) => OpenAILike;
    try {
      // Widened specifier: keeps the SDK an optional runtime dep (no compile-time resolution).
      const spec: string = 'openai';
      const mod = (await import(spec)) as { default: typeof OpenAI };
      OpenAI = mod.default;
    } catch {
      throw new Error("OpenAIDriver requires 'openai'. Install it, or inject a client via { client }.");
    }
    this.#client = new OpenAI({ apiKey: this.#options.apiKey });
    return this.#client;
  }
}

function buildParams(req: GenerateRequest, model: string): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) messages.push(...toOpenAIMessages(m));

  const params: Record<string, unknown> = { model, messages };
  if (req.maxTokens) params.max_tokens = req.maxTokens;
  if (req.responseFormat) {
    params.response_format = {
      type: 'json_schema',
      json_schema: { name: req.responseFormat.name ?? 'output', schema: req.responseFormat.schema, strict: true },
    };
  }
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }
  return params;
}

/** Expand one normalized message into the OpenAI message(s) it maps to (tool_results become separate `tool` messages). */
function toOpenAIMessages(m: ModelMessage): Array<Record<string, unknown>> {
  if (typeof m.content === 'string') return [{ role: m.role, content: m.content }];

  const text = m.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('');
  const toolUses = m.content.filter((b) => b.type === 'tool_use');
  const toolResults = m.content.filter((b) => b.type === 'tool_result');
  const out: Array<Record<string, unknown>> = [];

  if (m.role === 'assistant' && toolUses.length > 0) {
    out.push({
      role: 'assistant',
      content: text || null,
      tool_calls: toolUses.map((b) =>
        b.type === 'tool_use'
          ? { id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }
          : {},
      ),
    });
  } else if (text || toolResults.length === 0) {
    out.push({ role: m.role, content: text });
  }
  for (const b of toolResults) {
    if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
  }
  return out;
}

function toResult(res: OpenAICompletion, model: string, provider: string): GenerateResult {
  const choice = res.choices[0];
  const usage: Usage = {
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
  };
  const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map((c) => ({
    id: c.id,
    name: c.function.name,
    input: safeParse(c.function.arguments),
  }));
  return {
    text: choice?.message?.content ?? '',
    model,
    provider,
    usage,
    costUsd: computeCost(model, usage),
    stopReason: choice?.finish_reason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    raw: res,
  };
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return json;
  }
}

function classify(err: unknown): Error {
  const status = (err as { status?: number })?.status;
  if (status === 408 || status === 409 || status === 429 || (status !== undefined && status >= 500)) {
    return new RetryableModelError(`OpenAI request failed (${status})`, { status, cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

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

/**
 * Minimal surface the driver depends on — a normalized wrapper over
 * `@google/generative-ai`. Lets tests inject a fake and keeps the SDK's
 * per-call `getGenerativeModel(...)` shape out of the mapping code.
 */
export interface GeminiLike {
  generate(args: {
    model: string;
    systemInstruction?: string;
    tools?: unknown;
    contents: unknown[];
    signal?: AbortSignal;
  }): Promise<GeminiResult>;
}

interface GeminiResult {
  text: string;
  functionCalls?: Array<{ name: string; args: unknown }>;
  usage?: { promptTokenCount?: number; candidatesTokenCount?: number };
  finishReason?: string;
}

export interface GeminiDriverOptions {
  apiKey?: string;
  defaultModel?: string;
  client?: GeminiLike;
}

/**
 * Google Gemini driver — thin adapter over `@google/generative-ai`, loaded
 * lazily. Gemini uses `model`/`user` roles, a separate `systemInstruction`,
 * and `functionCall`/`functionResponse` parts (no call ids), so the driver
 * encodes the tool name into the synthesized ToolCall id and recovers it when
 * mapping tool results back.
 */
export class GeminiDriver implements ModelDriver {
  readonly provider = 'gemini';
  #options: GeminiDriverOptions;
  #client?: GeminiLike;

  constructor(options: GeminiDriverOptions = {}) {
    this.#options = options;
    this.#client = options.client;
  }

  supports(model: string): boolean {
    return model.startsWith('gemini');
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const client = await this.#getClient();
    const model = req.model ?? this.#options.defaultModel ?? 'gemini-2.5-flash';

    const systemParts = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    const systemInstruction = [req.system, ...systemParts].filter(Boolean).join('\n\n') || undefined;
    const contents = req.messages.filter((m) => m.role !== 'system').map(toGeminiContent);
    const tools = req.tools?.length
      ? [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }]
      : undefined;

    try {
      const res = await client.generate({ model, systemInstruction, tools, contents, signal: req.signal });
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

  async #getClient(): Promise<GeminiLike> {
    if (this.#client) return this.#client;
    let GoogleGenerativeAI: new (apiKey?: string) => {
      getGenerativeModel(config: Record<string, unknown>): {
        generateContent(
          req: Record<string, unknown>,
          opts?: { signal?: AbortSignal },
        ): Promise<{ response: GeminiSdkResponse }>;
      };
    };
    try {
      // Widened specifier keeps the SDK an optional runtime dep.
      const spec: string = '@google/generative-ai';
      const mod = (await import(spec)) as { GoogleGenerativeAI: typeof GoogleGenerativeAI };
      GoogleGenerativeAI = mod.GoogleGenerativeAI;
    } catch {
      throw new Error(
        "GeminiDriver requires '@google/generative-ai'. Install it, or inject a client via { client }.",
      );
    }
    const genAI = new GoogleGenerativeAI(this.#options.apiKey);
    this.#client = {
      async generate(args) {
        const model = genAI.getGenerativeModel({
          model: args.model,
          systemInstruction: args.systemInstruction,
          tools: args.tools,
        });
        const res = await model.generateContent({ contents: args.contents }, { signal: args.signal });
        const r = res.response;
        let text = '';
        try {
          text = r.text?.() ?? '';
        } catch {
          text = '';
        }
        return {
          text,
          functionCalls: r.functionCalls?.() ?? undefined,
          usage: r.usageMetadata,
          finishReason: r.candidates?.[0]?.finishReason,
        };
      },
    };
    return this.#client;
  }
}

interface GeminiSdkResponse {
  text?: () => string;
  functionCalls?: () => Array<{ name: string; args: unknown }> | undefined;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  candidates?: Array<{ finishReason?: string }>;
}

function toGeminiContent(m: ModelMessage): { role: string; parts: unknown[] } {
  const role = m.role === 'assistant' ? 'model' : 'user';
  if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };

  const parts: unknown[] = [];
  for (const b of m.content as ContentBlock[]) {
    switch (b.type) {
      case 'text':
        if (b.text) parts.push({ text: b.text });
        break;
      case 'tool_use':
        parts.push({ functionCall: { name: b.name, args: b.input } });
        break;
      case 'tool_result':
        parts.push({
          functionResponse: { name: nameFromId(b.toolUseId), response: asObject(b.content) },
        });
        break;
    }
  }
  return { role, parts };
}

function toResult(res: GeminiResult, model: string, provider: string): GenerateResult {
  const toolCalls: ToolCall[] = (res.functionCalls ?? []).map((c, i) => ({
    // Gemini function calls carry no id — synthesize one that embeds the name
    // so the tool_result can be mapped back to a functionResponse.
    id: `${c.name}::${i}`,
    name: c.name,
    input: c.args,
  }));
  const usage: Usage = {
    inputTokens: res.usage?.promptTokenCount ?? 0,
    outputTokens: res.usage?.candidatesTokenCount ?? 0,
  };
  return {
    text: res.text,
    model,
    provider,
    usage,
    costUsd: computeCost(model, usage),
    stopReason: res.finishReason,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    raw: res,
  };
}

function nameFromId(id: string): string {
  return id.split('::')[0] ?? id;
}

/** Gemini's functionResponse.response must be an object; parse JSON or wrap. */
function asObject(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { result: parsed };
  } catch {
    return { result: content };
  }
}

function classify(err: unknown): Error {
  const status = (err as { status?: number })?.status;
  const message = (err as { message?: string })?.message ?? '';
  const transientCode = status === 429 || status === 503 || (status !== undefined && status >= 500);
  const transientMessage = /\b(429|500|502|503|overloaded|unavailable|rate limit)\b/i.test(message);
  if (transientCode || transientMessage) {
    return new RetryableModelError(`Gemini request failed${status ? ` (${status})` : ''}`, { status, cause: err });
  }
  return err instanceof Error ? err : new Error(String(err));
}

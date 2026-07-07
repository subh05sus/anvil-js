import type { Span, Trace } from './types.js';

/**
 * Map an Anvil trace to an OTLP `resourceSpans` payload following the
 * OpenTelemetry GenAI semantic conventions (PRD §6.25), so traces flow into
 * Datadog / Grafana / Langfuse / Braintrust alongside the local dashboard.
 */
export function traceToOtelSpans(trace: Trace, serviceName = 'anvil'): OtlpResourceSpans {
  return {
    resource: { attributes: [kv('service.name', serviceName)] },
    scopeSpans: [
      {
        scope: { name: 'anvil', version: '1.0.0' },
        spans: trace.spans.map((s) => toOtelSpan(s, trace.id)),
      },
    ],
  };
}

function toOtelSpan(span: Span, traceId: string): OtlpSpan {
  const attrs: OtlpAttribute[] = [kv('gen_ai.operation.name', span.kind)];
  const a = span.attributes;

  if (span.kind === 'model') {
    if (typeof a.provider === 'string') attrs.push(kv('gen_ai.system', a.provider));
    if (typeof a.model === 'string') {
      attrs.push(kv('gen_ai.request.model', a.model), kv('gen_ai.response.model', a.model));
    }
    const usage = a.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    if (usage) {
      attrs.push(kvInt('gen_ai.usage.input_tokens', usage.inputTokens ?? 0));
      attrs.push(kvInt('gen_ai.usage.output_tokens', usage.outputTokens ?? 0));
    }
    if (typeof a.costUsd === 'number') attrs.push(kvDouble('gen_ai.usage.cost', a.costUsd));
  } else if (span.kind === 'tool') {
    if (typeof a.name === 'string') attrs.push(kv('gen_ai.tool.name', a.name));
  }

  return {
    traceId: toHex(traceId, 32),
    spanId: toHex(span.id, 16),
    parentSpanId: span.parentId ? toHex(span.parentId, 16) : undefined,
    name: span.name,
    kind: 1, // SPAN_KIND_INTERNAL
    startTimeUnixNano: nanos(span.startedAt),
    endTimeUnixNano: nanos(span.endedAt ?? span.startedAt),
    attributes: attrs,
    status: { code: span.status === 'error' ? 2 : span.status === 'ok' ? 1 : 0, message: span.error },
  };
}

export interface OtlpExporterOptions {
  url: string;
  headers?: Record<string, string>;
  serviceName?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Returns an `onExport` callback for the Tracer that POSTs each finished trace
 * to an OTLP/HTTP endpoint. Fire-and-forget; failures are logged, not thrown,
 * so telemetry never breaks a request.
 */
export function otlpHttpExporter(options: OtlpExporterOptions): (trace: Trace) => void {
  const doFetch = options.fetch ?? fetch;
  return (trace: Trace) => {
    const body = JSON.stringify({ resourceSpans: [traceToOtelSpans(trace, options.serviceName)] });
    void Promise.resolve(
      doFetch(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body,
      }),
    ).catch((err: unknown) => {
      console.error('[anvil] OTLP export failed:', err instanceof Error ? err.message : err);
    });
  };
}

// ── OTLP JSON shapes (subset) ──────────────────────────────────────

export interface OtlpResourceSpans {
  resource: { attributes: OtlpAttribute[] };
  scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}
export interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string; doubleValue?: number };
}

function kv(key: string, value: string): OtlpAttribute {
  return { key, value: { stringValue: value } };
}
function kvInt(key: string, value: number): OtlpAttribute {
  return { key, value: { intValue: String(Math.trunc(value)) } };
}
function kvDouble(key: string, value: number): OtlpAttribute {
  return { key, value: { doubleValue: value } };
}

/** UUID → hex id of the given length (traceId 32 hex = 16 bytes, spanId 16 = 8 bytes). */
function toHex(id: string, length: number): string {
  const hex = id.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return (hex + '0'.repeat(length)).slice(0, length);
}

function nanos(ms: number): string {
  return `${ms}000000`;
}

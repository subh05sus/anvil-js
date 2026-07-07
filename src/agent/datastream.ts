import type { AgentEvent } from './runtime.js';

/**
 * Encode agent events as the Vercel AI SDK **data stream protocol** so
 * `useChat`/`useCompletion` (with `streamProtocol: 'data'`) consume Anvil
 * agent routes out of the box (PRD §6.18). Each part is a prefix-coded,
 * newline-terminated line; text/objects are JSON-encoded.
 */
export function encodeDataStreamPart(event: AgentEvent, messageId: string): string | null {
  switch (event.type) {
    case 'iteration':
      // Start-of-step marker (part code 'f').
      return `f:${JSON.stringify({ messageId: `${messageId}-${event.n}` })}\n`;
    case 'text':
      return `0:${JSON.stringify(event.text)}\n`;
    case 'tool_call':
      return `9:${JSON.stringify({ toolCallId: event.id, toolName: event.name, args: event.input })}\n`;
    case 'tool_result':
      return `a:${JSON.stringify({ toolCallId: event.id, result: event.output })}\n`;
    case 'suspended':
      // Surface HITL suspension as a data part (AI SDK exposes `2:` on `data`).
      return `2:${JSON.stringify([{ anvilSuspended: { runId: event.runId, callId: event.callId, payload: event.payload } }])}\n`;
    case 'final':
      return `d:${JSON.stringify({ finishReason: 'stop', usage: usage(event.usage) })}\n`;
    case 'error':
      return `3:${JSON.stringify(event.error)}\n`;
  }
}

function usage(u: { inputTokens: number; outputTokens: number }): { promptTokens: number; completionTokens: number } {
  return { promptTokens: u.inputTokens, completionTokens: u.outputTokens };
}

export interface DataStreamResponseOptions {
  messageId?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Turn an agent event stream into a web-standard streaming Response in the AI
 * SDK data stream format. Cancels the generator on client disconnect.
 */
export function toDataStreamResponse(
  events: AsyncIterable<AgentEvent>,
  options: DataStreamResponseOptions = {},
): Response {
  const messageId = options.messageId ?? 'msg';
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of events) {
          const part = encodeDataStreamPart(event, messageId);
          if (part) controller.enqueue(encoder.encode(part));
          if (options.signal?.aborted) break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`3:${JSON.stringify(message)}\n`));
      } finally {
        controller.close();
      }
    },
  });

  const headers = new Headers(options.headers);
  headers.set('content-type', 'text/plain; charset=utf-8');
  headers.set('x-vercel-ai-data-stream', 'v1');
  return new Response(stream, { headers });
}

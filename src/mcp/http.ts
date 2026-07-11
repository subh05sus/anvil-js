import type { McpServer } from './server.js';
import { McpSessionStore, sseStream } from './session.js';
import {
  RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './types.js';

export interface McpHttpOptions {
  /** Endpoint path. Default: '/mcp'. */
  path?: string;
  /**
   * Enable the stateful transport: sessions (`Mcp-Session-Id`), a GET SSE
   * stream for server→client notifications, and DELETE to terminate. Default:
   * false (stateless — POST-only, back-compatible).
   */
  stateful?: boolean;
  /** Idle session TTL (stateful only). */
  sessionTtlMs?: number;
  /** Max concurrent sessions (stateful only). */
  maxSessions?: number;
  /** Allowed `Origin` values (DNS-rebinding protection). Omit to allow any. */
  allowedOrigins?: string[];
}

/**
 * MCP Streamable HTTP transport as a web-standard fetch handler. Stateless by
 * default (POST carries a JSON-RPC request; the response is JSON). Set
 * `stateful: true` for sessions + a GET SSE stream + DELETE termination.
 */
export function mcpHttpHandler(server: McpServer, options: McpHttpOptions = {}): (req: Request) => Promise<Response> {
  const endpoint = options.path ?? '/mcp';
  return options.stateful ? statefulHandler(server, endpoint, options) : statelessHandler(server, endpoint);
}

function statelessHandler(server: McpServer, endpoint: string): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== endpoint) {
      return Response.json({ error: 'Not Found' }, { status: 404 });
    }
    if (req.method === 'GET') {
      // No standing server→client stream in stateless mode.
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }
    if (req.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST' } });
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return Response.json(rpcError(null, RPC.PARSE_ERROR, 'Parse error'), { status: 200 });
    }

    const batch = Array.isArray(payload);
    const messages = (batch ? payload : [payload]) as JsonRpcRequest[];

    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await server.handle(message);
      if (response) responses.push(response);
    }

    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(batch ? responses : responses[0]);
  };
}

function statefulHandler(
  server: McpServer,
  endpoint: string,
  options: McpHttpOptions,
): (req: Request) => Promise<Response> {
  const sessions = new McpSessionStore({ ttlMs: options.sessionTtlMs, maxSessions: options.maxSessions });
  // Fan server-initiated notifications out to every open SSE stream.
  server.onNotification((note) => sessions.broadcast(note));

  const originAllowed = (origin: string | null): boolean => {
    if (!options.allowedOrigins || origin === null) return true;
    return options.allowedOrigins.includes(origin);
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== endpoint) return Response.json({ error: 'Not Found' }, { status: 404 });
    if (!originAllowed(req.headers.get('origin'))) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const sessionId = req.headers.get('mcp-session-id') ?? undefined;

    if (req.method === 'GET') {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) return new Response(null, { status: 404 });
      return new Response(sseStream(session, req.signal), {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'mcp-session-id': session.id,
        },
      });
    }

    if (req.method === 'DELETE') {
      if (sessionId) sessions.delete(sessionId);
      return new Response(null, { status: 204 });
    }

    if (req.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'GET, POST, DELETE' } });
    }

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return Response.json(rpcError(null, RPC.PARSE_ERROR, 'Parse error'), { status: 200 });
    }
    // Batching was removed in MCP 2025-06-18.
    if (Array.isArray(payload)) {
      return Response.json(rpcError(null, RPC.INVALID_REQUEST, 'JSON-RPC batching is not supported'), { status: 400 });
    }
    const message = payload as JsonRpcRequest;

    if (message.method === 'initialize') {
      const response = await server.handle(message);
      const protocolVersion =
        (response && 'result' in response
          ? (response.result as { protocolVersion?: string }).protocolVersion
          : undefined) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
      const session = sessions.create(protocolVersion);
      if (!response) return new Response(null, { status: 202, headers: { 'mcp-session-id': session.id } });
      return Response.json(response, { headers: { 'mcp-session-id': session.id } });
    }

    // Non-initialize requests must carry a live session.
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) return new Response(null, { status: 404 });

    // Validate the protocol-version header when present.
    const versionHeader = req.headers.get('mcp-protocol-version');
    if (versionHeader && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(versionHeader)) {
      return Response.json(
        rpcError(message.id ?? null, RPC.INVALID_REQUEST, `Unsupported MCP-Protocol-Version: ${versionHeader}`),
        { status: 400 },
      );
    }

    const response = await server.handle(message);
    if (!response) return new Response(null, { status: 202 });
    return Response.json(response, { headers: { 'mcp-session-id': session.id } });
  };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

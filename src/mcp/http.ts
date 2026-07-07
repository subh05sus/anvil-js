import type { McpServer } from './server.js';
import { RPC, type JsonRpcRequest, type JsonRpcResponse } from './types.js';

export interface McpHttpOptions {
  /** Endpoint path. Default: '/mcp'. */
  path?: string;
}

/**
 * MCP Streamable HTTP transport as a web-standard fetch handler, so it mounts
 * directly into an Anvil app. Stateless: POST carries a JSON-RPC request (or
 * batch); the response is returned as JSON. GET (server-initiated SSE stream)
 * is not offered in this stateless mode.
 */
export function mcpHttpHandler(server: McpServer, options: McpHttpOptions = {}): (req: Request) => Promise<Response> {
  const endpoint = options.path ?? '/mcp';

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

    // All notifications → nothing to return.
    if (responses.length === 0) return new Response(null, { status: 202 });

    return Response.json(batch ? responses : responses[0]);
  };
}

function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

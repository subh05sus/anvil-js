import type { z } from 'zod';
import type { JsonSchema } from '../compiler/json-schema.js';

/**
 * A single MCP tool. Unifies the two sources Anvil exposes — routes marked
 * `meta.mcp.expose` and files under `server/tools/` — behind one shape so the
 * server, HTTP transport, and stdio transport are source-agnostic.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema advertised to clients (from the M1 zod→JSON-Schema converter). */
  inputSchema: JsonSchema;
  /** Original Zod schema — re-validates arguments at call time so refinements still enforce. */
  zodSchema: z.ZodTypeAny;
  /** Run the tool. Returns plain data; the server wraps it in MCP content. */
  invoke: (args: unknown) => Promise<unknown>;
  source: 'route' | 'registry';
  /** Source file, for diagnostics. */
  file?: string;
}

// ── JSON-RPC 2.0 ────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** MCP protocol revision Anvil implements. */
export const PROTOCOL_VERSION = '2025-06-18';

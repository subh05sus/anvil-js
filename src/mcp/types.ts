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

/** Contents returned by a resource read — text or base64 blob. */
export type ResourceContents =
  | { uri?: string; mimeType?: string; text: string }
  | { uri?: string; mimeType?: string; blob: string };

/** A static MCP resource (addressable by a fixed URI). */
export interface ResourceDefinition {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  file?: string;
  read: () => Promise<ResourceContents> | ResourceContents;
}

/** A parameterized MCP resource (RFC 6570-style `uriTemplate`). */
export interface ResourceTemplateDefinition {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  file?: string;
  read: (vars: Record<string, string>) => Promise<ResourceContents> | ResourceContents;
}

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description?: string;
  messages: PromptMessage[];
}

/** An MCP prompt template. */
export interface PromptDefinition {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
  file?: string;
  get: (args: Record<string, unknown>) => Promise<PromptResult> | PromptResult;
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

/** A JSON-RPC notification (no id) the server sends to a client over SSE. */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export const RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  /** MCP: resource not found. */
  RESOURCE_NOT_FOUND: -32002,
} as const;

/** MCP protocol revision Anvil implements. */
export const PROTOCOL_VERSION = '2025-06-18';

/** Protocol revisions this server can negotiate down to. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26'] as const;

import type { ToolDefinition } from './types.js';
import { PROTOCOL_VERSION, RPC, type JsonRpcRequest, type JsonRpcResponse } from './types.js';

export interface McpServerInfo {
  name: string;
  version: string;
}

/**
 * Transport-agnostic MCP server. Handles the tool-serving subset of the
 * protocol (initialize, tools/list, tools/call, ping). Server-initiated
 * messages and resources/prompts are out of scope for M2.
 */
export class McpServer {
  #tools: Map<string, ToolDefinition>;
  #info: McpServerInfo;

  constructor(tools: ToolDefinition[], info: McpServerInfo) {
    this.#tools = new Map(tools.map((t) => [t.name, t]));
    this.#info = info;
  }

  get tools(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  /**
   * Process one JSON-RPC message. Returns the response, or null for
   * notifications (requests with no `id`) which must not be answered.
   */
  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const isNotification = message.id === undefined || message.id === null;
    const id = message.id ?? null;

    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return isNotification ? null : this.#error(id, RPC.INVALID_REQUEST, 'Invalid JSON-RPC request');
    }

    try {
      switch (message.method) {
        case 'initialize':
          return isNotification ? null : this.#ok(id, this.#initialize());
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null; // Acknowledge silently.
        case 'ping':
          return isNotification ? null : this.#ok(id, {});
        case 'tools/list':
          return isNotification ? null : this.#ok(id, { tools: this.#listTools() });
        case 'tools/call': {
          if (isNotification) return null;
          return await this.#callTool(id, message.params);
        }
        default:
          return isNotification ? null : this.#error(id, RPC.METHOD_NOT_FOUND, `Unknown method: ${message.method}`);
      }
    } catch (err) {
      return isNotification ? null : this.#error(id, RPC.INTERNAL_ERROR, errorMessage(err));
    }
  }

  #initialize(): unknown {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: this.#info,
    };
  }

  #listTools(): unknown[] {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async #callTool(id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
    const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: unknown };
    if (typeof name !== 'string') {
      return this.#error(id, RPC.INVALID_PARAMS, 'tools/call requires a "name"');
    }
    const tool = this.#tools.get(name);
    if (!tool) return this.#error(id, RPC.INVALID_PARAMS, `Unknown tool: ${name}`);

    // Re-validate with the original Zod schema so refinements still enforce
    // (JSON Schema advertised to the client can be lossier).
    const parsed = tool.zodSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return this.#ok(id, {
        isError: true,
        content: [{ type: 'text', text: `Invalid arguments: ${parsed.error.message}` }],
      });
    }

    try {
      const result = await tool.invoke(parsed.data);
      return this.#ok(id, { content: [{ type: 'text', text: stringify(result) }] });
    } catch (err) {
      // Tool execution failures surface as an MCP tool error, not a protocol error.
      return this.#ok(id, { isError: true, content: [{ type: 'text', text: errorMessage(err) }] });
    }
  }

  #ok(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  #error(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null, null, 2);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

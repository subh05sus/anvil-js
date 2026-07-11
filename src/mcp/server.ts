import {
  PROTOCOL_VERSION,
  RPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type PromptDefinition,
  type ResourceContents,
  type ResourceDefinition,
  type ResourceTemplateDefinition,
  type ToolDefinition,
} from './types.js';

export interface McpServerInfo {
  name: string;
  version: string;
}

export interface McpServerOptions {
  info: McpServerInfo;
  tools?: ToolDefinition[];
  resources?: ResourceDefinition[];
  resourceTemplates?: ResourceTemplateDefinition[];
  prompts?: PromptDefinition[];
}

/**
 * Transport-agnostic MCP server. Handles tools, resources, and prompts over
 * JSON-RPC (initialize, tools/*, resources/*, prompts/*, ping). Server-initiated
 * `list_changed` notifications are emitted to subscribers via `onNotification`.
 */
export class McpServer {
  #tools: Map<string, ToolDefinition>;
  #resources: Map<string, ResourceDefinition>;
  #resourceTemplates: ResourceTemplateDefinition[];
  #prompts: Map<string, PromptDefinition>;
  #info: McpServerInfo;
  #listeners = new Set<(n: JsonRpcNotification) => void>();

  constructor(toolsOrOptions: ToolDefinition[] | McpServerOptions, info?: McpServerInfo) {
    if (Array.isArray(toolsOrOptions)) {
      // Legacy positional form: new McpServer(tools, info).
      this.#tools = new Map(toolsOrOptions.map((t) => [t.name, t]));
      this.#resources = new Map();
      this.#resourceTemplates = [];
      this.#prompts = new Map();
      this.#info = info!;
    } else {
      this.#tools = new Map((toolsOrOptions.tools ?? []).map((t) => [t.name, t]));
      this.#resources = new Map((toolsOrOptions.resources ?? []).map((r) => [r.uri, r]));
      this.#resourceTemplates = toolsOrOptions.resourceTemplates ?? [];
      this.#prompts = new Map((toolsOrOptions.prompts ?? []).map((p) => [p.name, p]));
      this.#info = toolsOrOptions.info;
    }
  }

  get tools(): ToolDefinition[] {
    return [...this.#tools.values()];
  }

  get resources(): ResourceDefinition[] {
    return [...this.#resources.values()];
  }

  get prompts(): PromptDefinition[] {
    return [...this.#prompts.values()];
  }

  /** Subscribe to server-initiated notifications (e.g. list_changed). Returns an unsubscribe. */
  onNotification(cb: (n: JsonRpcNotification) => void): () => void {
    this.#listeners.add(cb);
    return () => this.#listeners.delete(cb);
  }

  notifyToolsChanged(): void {
    this.#emit('notifications/tools/list_changed');
  }
  notifyResourcesChanged(): void {
    this.#emit('notifications/resources/list_changed');
  }
  notifyPromptsChanged(): void {
    this.#emit('notifications/prompts/list_changed');
  }

  #emit(method: string): void {
    const note: JsonRpcNotification = { jsonrpc: '2.0', method };
    for (const cb of this.#listeners) cb(note);
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
          return isNotification ? null : this.#ok(id, this.#initialize(message.params));
        case 'notifications/initialized':
        case 'notifications/cancelled':
          return null; // Acknowledge silently.
        case 'ping':
          return isNotification ? null : this.#ok(id, {});
        case 'tools/list':
          return isNotification ? null : this.#ok(id, { tools: this.#listTools() });
        case 'tools/call':
          return isNotification ? null : await this.#callTool(id, message.params);
        case 'resources/list':
          return isNotification ? null : this.#ok(id, { resources: this.#listResources() });
        case 'resources/templates/list':
          return isNotification ? null : this.#ok(id, { resourceTemplates: this.#listResourceTemplates() });
        case 'resources/read':
          return isNotification ? null : await this.#readResource(id, message.params);
        case 'prompts/list':
          return isNotification ? null : this.#ok(id, { prompts: this.#listPrompts() });
        case 'prompts/get':
          return isNotification ? null : await this.#getPrompt(id, message.params);
        default:
          return isNotification ? null : this.#error(id, RPC.METHOD_NOT_FOUND, `Unknown method: ${message.method}`);
      }
    } catch (err) {
      return isNotification ? null : this.#error(id, RPC.INTERNAL_ERROR, errorMessage(err));
    }
  }

  #initialize(params: unknown): unknown {
    const requested = (params as { protocolVersion?: string })?.protocolVersion;
    const protocolVersion =
      requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : PROTOCOL_VERSION;

    const capabilities: Record<string, unknown> = { tools: { listChanged: false } };
    if (this.#resources.size > 0 || this.#resourceTemplates.length > 0) {
      capabilities.resources = { subscribe: false, listChanged: true };
    }
    if (this.#prompts.size > 0) {
      capabilities.prompts = { listChanged: true };
    }

    return { protocolVersion, capabilities, serverInfo: this.#info };
  }

  #listTools(): unknown[] {
    return this.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  #listResources(): unknown[] {
    return this.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      ...(r.title ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
      ...(r.size !== undefined ? { size: r.size } : {}),
    }));
  }

  #listResourceTemplates(): unknown[] {
    return this.#resourceTemplates.map((r) => ({
      uriTemplate: r.uriTemplate,
      name: r.name,
      ...(r.title ? { title: r.title } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.mimeType ? { mimeType: r.mimeType } : {}),
    }));
  }

  #listPrompts(): unknown[] {
    return this.prompts.map((p) => ({
      name: p.name,
      ...(p.title ? { title: p.title } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.arguments ? { arguments: p.arguments } : {}),
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

  async #readResource(id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
    const uri = (params as { uri?: string })?.uri;
    if (typeof uri !== 'string') {
      return this.#error(id, RPC.INVALID_PARAMS, 'resources/read requires a "uri"');
    }
    const stat = this.#resources.get(uri);
    if (stat) {
      const contents = await stat.read();
      return this.#ok(id, { contents: [this.#resourceContent(uri, stat.mimeType, contents)] });
    }
    // Try templates.
    for (const template of this.#resourceTemplates) {
      const vars = matchTemplate(template.uriTemplate, uri);
      if (vars) {
        const contents = await template.read(vars);
        return this.#ok(id, { contents: [this.#resourceContent(uri, template.mimeType, contents)] });
      }
    }
    return this.#error(id, RPC.RESOURCE_NOT_FOUND, `Resource not found: ${uri}`);
  }

  #resourceContent(uri: string, defaultMime: string | undefined, contents: ResourceContents): unknown {
    const mimeType = contents.mimeType ?? defaultMime;
    const base = { uri: contents.uri ?? uri, ...(mimeType ? { mimeType } : {}) };
    return 'text' in contents ? { ...base, text: contents.text } : { ...base, blob: contents.blob };
  }

  async #getPrompt(id: string | number | null, params: unknown): Promise<JsonRpcResponse> {
    const { name, arguments: args } = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
    if (typeof name !== 'string') {
      return this.#error(id, RPC.INVALID_PARAMS, 'prompts/get requires a "name"');
    }
    const prompt = this.#prompts.get(name);
    if (!prompt) return this.#error(id, RPC.INVALID_PARAMS, `Unknown prompt: ${name}`);
    const result = await prompt.get(args ?? {});
    return this.#ok(id, {
      ...(result.description ? { description: result.description } : {}),
      messages: result.messages,
    });
  }

  #ok(id: string | number | null, result: unknown): JsonRpcResponse {
    return { jsonrpc: '2.0', id, result };
  }

  #error(id: string | number | null, code: number, message: string): JsonRpcResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

/**
 * Match a URI against a simple `{var}` template (RFC 6570 level-1 subset).
 * Returns decoded variables, or null if the URI doesn't match.
 */
function matchTemplate(template: string, uri: string): Record<string, string> | null {
  const names: string[] = [];
  const pattern = template.replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === '{' || m === '}' ? m : `\\${m}`));
  const regexSrc =
    '^' +
    pattern.replace(/\{([^}]+)\}/g, (_m, name: string) => {
      names.push(name);
      return '([^/]+)';
    }) +
    '$';
  const match = new RegExp(regexSrc).exec(uri);
  if (!match) return null;
  const vars: Record<string, string> = {};
  names.forEach((name, i) => {
    vars[name] = decodeURIComponent(match[i + 1]!);
  });
  return vars;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value ?? null, null, 2);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

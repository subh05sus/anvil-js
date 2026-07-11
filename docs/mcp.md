# MCP & tools

Anvil's core wedge: **the same file that serves a REST route can be an MCP tool.** No second codebase, no duplicated schema.

## Exposing a route

```ts
export const meta = { mcp: { expose: true, description: 'Fetch a widget by id' } };
export const paramsSchema = z.object({ id: z.string() });
export const bodySchema = z.object({ note: z.string().optional() }); // merged into the tool's input schema too

export default function handler(ctx) { /* ... */ }
```

The tool's name defaults to `{method}_{path}` (e.g. `get_widgets_by_id`); override with `meta.mcp.name`.

## Standalone tools

Tools with no HTTP route live in `server/tools/`:

```ts
// server/tools/word_count.ts
import { z } from 'zod';
export const description = 'Count words in a piece of text';
export const inputSchema = z.object({ text: z.string() });
export default async function wordCount(args: { text: string }) {
  return { words: args.text.trim().split(/\s+/).length };
}
```

## Resources & prompts

Beyond tools, the server exposes **resources** and **prompts**. Files under `server/resources/` and `server/prompts/` are auto-discovered.

```ts
// server/resources/changelog.ts — a static resource
export const uri = 'anvil://changelog';
export const name = 'changelog';
export const mimeType = 'text/markdown';
export const read = async () => ({ text: await readFile('CHANGELOG.md', 'utf8') });
```

```ts
// server/resources/user.ts — a templated resource (RFC 6570 {var})
export const uriTemplate = 'anvil://users/{id}';
export const name = 'user';
export const read = (vars) => ({ text: JSON.stringify(findUser(vars.id)) });
```

```ts
// server/prompts/triage.ts — a prompt with {{var}} placeholders
export const name = 'triage';
export const description = 'Triage an incoming issue';
export const template = 'Classify this {{severity}} issue:\n\n{{body}}';
```

Versioned prompts from a `PromptRegistry` can be exposed too — pass `promptRegistry` to `buildServer` (see below); each `{{var}}` becomes a prompt argument.

> **Path safety:** for file-backed templated resources, use `fileResource(root, vars.path)` — it decodes and contains the path within `root`, rejecting traversal (`../`).

## Serving

```bash
anvil mcp                 # Streamable HTTP on :3100/mcp (default, stateless)
anvil mcp --stateful      # sessions (Mcp-Session-Id) + GET SSE stream + DELETE
anvil mcp --stdio         # stdio, for Claude Desktop and other local clients
anvil mcp --port 4000 --endpoint /tools
anvil mcp --resources server/resources --prompts server/prompts
```

The server implements `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get`, and `ping`. Arguments are re-validated against the original Zod schema at call time (so refinements the JSON Schema can't express still enforce), and tool execution failures surface as an MCP `isError` result rather than a protocol error.

**Stateless (default):** each POST carries one JSON-RPC request; the response is JSON. **Stateful (`--stateful`):** `initialize` returns an `Mcp-Session-Id`; subsequent requests must echo it (unknown/expired → 404). A `GET` with `Accept: text/event-stream` opens a server→client stream that receives `*/list_changed` notifications; `DELETE` terminates the session. JSON-RPC batching (removed in MCP `2025-06-18`) is rejected in stateful mode.

## Programmatic use

```ts
import { buildServer, McpServer, mcpHttpHandler } from 'anvil-sdk/mcp';

const built = await buildServer({
  routesDir: 'server/routes',
  toolsDir: 'server/tools',
  resourcesDir: 'server/resources',
  promptsDir: 'server/prompts',
  // promptRegistry, // optionally expose versioned prompts
});
const server = new McpServer({ info: { name: 'my-app', version: '1.0.0' }, ...built });
const handler = mcpHttpHandler(server, { stateful: true }); // a fetch handler — mount it anywhere
```

The legacy `new McpServer(tools, { name, version })` form still works for tools-only servers.

## A2A

The same tool registry backs Anvil's A2A (Agent2Agent) server — see [protocol & background agents](./protocol-background.md).

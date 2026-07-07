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

## Serving

```bash
anvil mcp                 # Streamable HTTP on :3100/mcp (default)
anvil mcp --stdio         # stdio, for Claude Desktop and other local clients
anvil mcp --port 4000 --endpoint /tools
```

The server implements `initialize`, `tools/list`, `tools/call`, and `ping`. Arguments are re-validated against the original Zod schema at call time (so refinements the JSON Schema can't express still enforce), and tool execution failures surface as an MCP `isError` result rather than a protocol error.

## Programmatic use

```ts
import { buildToolset, McpServer, mcpHttpHandler } from 'anvil-sdk/mcp';

const tools = await buildToolset({ routesDir: 'server/routes', toolsDir: 'server/tools' });
const server = new McpServer(tools, { name: 'my-app', version: '1.0.0' });
const handler = mcpHttpHandler(server); // a fetch handler — mount it anywhere
```

## A2A

The same tool registry backs Anvil's A2A (Agent2Agent) server — see [protocol & background agents](./protocol-background.md).

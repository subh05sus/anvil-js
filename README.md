# Anvil JS

> **Express for humans. Anvil for agents.**

Anvil is a Node.js backend framework for AI & GenAI developers: Express-level flexibility, Next.js-style file-based routing, compile-time route/schema validation, and a native agentic layer — MCP exposure, tool registry, agent orchestration, tracing — built into the framework core.

**Status: pre-alpha.** M0 (routing), M1 (compile-time validation), M2 (MCP auto-exposure + tool registry), and M3 (model client + agent routes) are implemented. See [PRD.md](./PRD.md) for the full roadmap.

## Quick start

```bash
npm install
npm run build
npm test
```

## File-based routing

```
server/routes/
  get.ts                  → GET /
  users/
    _middleware.ts        → scoped middleware for /users/**
    get.ts                → GET /users
    post.ts               → POST /users
    [id]/
      get.ts              → GET /users/:id
  files/
    [...path]/
      get.ts              → GET /files/* (catch-all)
  (admin)/                → route group, not part of the URL
    dashboard/
      get.ts              → GET /dashboard
```

A handler:

```ts
import type { Context } from 'anvil';

export default async function handler(ctx: Context) {
  return { id: ctx.params.id }; // plain objects auto-serialize to JSON
}
```

## CLI

- `anvil dev` — dev server with watch mode (TypeScript routes loaded on the fly)
- `anvil build` — generates the static route manifest (`.gen/routes.ts`) and bundles `dist/server.mjs`
- `anvil start` — runs the production bundle
- `anvil lint` — validates routes: `paramsSchema` keys match folder params, and any schema on an MCP-exposed route converts losslessly to JSON Schema (`--strict` fails on warnings too)
- `anvil mcp` — serves `meta.mcp.expose` routes and `server/tools/` as an MCP server over Streamable HTTP (`--stdio` for local clients like Claude Desktop)

## MCP: any route is also a tool

Mark a route exposed and it becomes an MCP tool — same handler, no second codebase:

```ts
export const meta = { mcp: { expose: true, description: 'Fetch a user by ID' } };
export const paramsSchema = z.object({ id: z.string() });
export default (ctx) => findUser(ctx.params.id);
```

```
anvil mcp                 # Streamable HTTP on :3100/mcp
anvil mcp --stdio         # for Claude Desktop et al.
```

Standalone tools live in `server/tools/*.ts` (a `default` function + `inputSchema`) and are served from the same command.

## Agent routes

An `agent.ts` file is an agent route — served over POST, streaming the Vercel AI SDK data stream protocol (so `useChat` works against it directly):

```ts
import { defineAgent } from 'anvil/agent';
import { LlmClient, AnthropicDriver } from 'anvil/llm';
import { z } from 'zod';

const client = new LlmClient({
  drivers: [new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY })],
  defaultModel: 'claude-opus-4-8',
  fallback: ['gpt-4o'], // requires an OpenAIDriver too
});

export default defineAgent({
  client,
  system: 'You are a helpful assistant.',
  tools: [
    {
      name: 'get_weather',
      description: 'Get weather for a city',
      zodSchema: z.object({ city: z.string() }),
      execute: ({ city }) => fetchWeather(city),
    },
  ],
});
```

The runtime runs the model↔tool loop (with an iteration cap), validates each tool's input against its Zod schema, tracks token usage and cost, and aborts the whole run — model call and tool execution — when the client disconnects.

## Roadmap (from PRD)

M0 routing ✅ → M1 compile-time validation → M2 MCP auto-exposure + tool registry → M3 LLM client + agent routes → M4 observability dashboard → M5 durability + HITL + guardrails → M6 evals + prompt registry + replay → M7 memory + RAG → M8 A2A + scheduled agents + sandbox → M9 launch.

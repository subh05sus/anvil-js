# Getting started

## Install

```bash
npm install anvil-sdk zod
```

Anvil is ESM-only, Node ≥ 20. `zod` is a direct dependency of your route/tool schemas (Anvil re-exports the pieces it needs, but you'll write your own `z.object(...)` calls).

## Scaffold a project

```bash
npx anvil init
```

Prompts for a starting point — **basic API**, **MCP server**, or **agent route** — then writes `package.json` (scripts + dependencies, merging into an existing file if one is present), `tsconfig.json`, `.gitignore`, and a starter route or two. Never overwrites a file that already exists. Skip the prompt with `--template basic|mcp|agent` or `-y` (defaults to basic), useful for scripting or CI.

## A route

```
server/routes/
  get.ts                → GET /
  users/
    get.ts               → GET /users
    post.ts              → POST /users
    [id]/
      get.ts             → GET /users/:id
```

```ts
// server/routes/users/[id]/get.ts
import { HttpError, type Context } from 'anvil-sdk';

export default function handler(ctx: Context) {
  const user = findUser(ctx.params.id);
  if (!user) throw new HttpError(404, `No user "${ctx.params.id}"`);
  return user; // plain objects auto-serialize to JSON
}
```

## Run it

```bash
npx anvil dev          # dev server, hot reload
npx anvil build        # generate the manifest + bundle for production
npx anvil start        # run the production bundle
```

## Make it an MCP tool — zero extra code

```ts
export const meta = { mcp: { expose: true, description: 'Fetch a user by ID' } };
export const paramsSchema = z.object({ id: z.string() });
export default function handler(ctx: Context) { /* same handler */ }
```

```bash
npx anvil mcp           # Streamable HTTP on :3100/mcp
npx anvil lint          # validates params/schemas, incl. MCP schema serializability
```

## Make it an agent

```ts
// server/routes/chat/agent.ts
import { defineAgent } from 'anvil-sdk/agent';
import { LlmClient, AnthropicDriver } from 'anvil-sdk/llm';

const client = new LlmClient({
  drivers: [new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY })],
  defaultModel: 'claude-opus-4-8',
});

export default defineAgent({ client, system: 'You are a helpful assistant.' });
```

`POST /chat` now streams the Vercel AI SDK data-stream protocol — `useChat` works against it directly.

## Where next

- [Routing](./routing.md) — file conventions, middleware, static files
- [Auth & security](./security.md) — authentication, sessions, rate limiting, body limits
- [MCP & tools](./mcp.md) — exposing routes and standalone tools
- [Agents](./agents.md) — tool calling, streaming, context assembly
- [Observability](./observability.md) — tracing, the dashboard, cost caps
- [Durability & safety](./durability-safety.md) — checkpointing, HITL, guardrails
- [Protocol & background agents](./protocol-background.md) — A2A, `anvil serve`, scheduled/triggered agents
- Examples: [`examples/basic-api`](../examples/basic-api), [`examples/mcp-server`](../examples/mcp-server), [`examples/agent-hitl`](../examples/agent-hitl)

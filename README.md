# Anvil JS

> **Express for humans. Anvil for agents.**

<img width="1672" height="941" alt="image" src="https://github.com/user-attachments/assets/44cc2422-80a6-40a5-88ad-9e92b729def4" />

Anvil is a Node.js backend framework for AI & GenAI developers. It's Express-level flexible, with Next.js-style file-based routing and full compile-time schema validation — and every route is automatically **type-safe, MCP-usable, A2A-usable, traced, cost-governed, and crash-resumable**, with zero extra code.

Not a chatbot template. Not an AI SDK wrapper. It's a general-purpose HTTP framework where the agentic layer — MCP exposure, tool registry, agent orchestration, observability, durability, guardrails — is built into the framework core instead of hand-wired on top of Express.

```ts
// server/routes/users/[id]/get.ts
export const meta = { mcp: { expose: true, description: 'Fetch a user by ID' } };
export const paramsSchema = z.object({ id: z.string() });

export default function handler(ctx) {
  return findUser(ctx.params.id);
}
```

That one file is now `GET /users/:id`, an MCP tool (`anvil mcp`), and an A2A skill — the same handler, the same schema, checked at build time, no duplication.

Core routing, MCP/A2A exposure, agent runtime, observability, durability, evals, memory/RAG, and background agents are all implemented and covered by 200+ tests.

---

## Quick start

```bash
mkdir my-api && cd my-api
npm init -y
npm install anvil-sdk zod
npx anvil init      # scaffolds package.json scripts, tsconfig, and a starter route
npm install
npx anvil dev       # dev server, hot reload
```

`anvil init` prompts for a starting point (basic API / MCP server / agent route), or skip the prompt with `--template <name>` / `-y`.

Or try a working example in under a minute:

```bash
cd examples/basic-api && npm install && npx anvil dev
```

## What's in the box

| Layer | What you get |
|---|---|
| **Routing** | File-based routes (`[id]`, `[...catchall]`, `(groups)`, scoped `_middleware.ts`), Express-parity static files/CORS, radix-tree matching |
| **Compile-time validation** | `anvil lint` — params match schemas, MCP-exposed schemas serialize losslessly, structural route conflicts fail the build (not the request) |
| **MCP & A2A** | `anvil mcp` (Streamable HTTP + stdio), `anvil/a2a` — one route/tool definition, three protocols |
| **Agents** | `defineAgent`, tool-calling loop with iteration caps, Vercel AI SDK streaming, abort-on-disconnect |
| **Model client** | `LlmClient` over Anthropic / OpenAI / Gemini (lazy, optional peer deps), fallback chains, retries, cost tracking, structured output |
| **Observability** | Trace tree per run, bundled `/_anvil` dashboard, cost governor, OpenTelemetry GenAI export |
| **Durability & safety** | Crash-resumable checkpointing (no double side-effects), human-in-the-loop approval, guardrails, prompt-injection taint layer |
| **Evals & replay** | `anvil eval` (deterministic + LLM-as-judge), versioned prompt registry, `anvil replay <traceId>` with zero live calls |
| **Memory & RAG** | `ctx.memory`, chunking + embeddings + vector store + traced retrieval, embedding-similarity semantic cache |
| **Background & multi-agent** | Scheduled (cron) and event-triggered agents, `AgentRegistry`/`callAgent` delegation |
| **Sandbox** | `worker_threads` + `vm`-isolated code execution for agent-written code (documented threat model) |

Full docs: **[docs/](./docs/README.md)**. Working examples: **[basic-api](./examples/basic-api)** · **[mcp-server](./examples/mcp-server)** · **[agent-hitl](./examples/agent-hitl)**.

## File-based routing

```
server/routes/
  get.ts                  → GET /
  users/
    _middleware.ts        → scoped middleware for /users/**
    get.ts                → GET /users
    post.ts                → POST /users
    [id]/
      get.ts              → GET /users/:id
  files/
    [...path]/
      get.ts              → GET /files/* (catch-all)
  (admin)/                → route group, not part of the URL
    dashboard/
      get.ts              → GET /dashboard
  chat/
    agent.ts              → POST /chat, an agent route (see below)
```

```ts
import type { Context } from 'anvil-sdk';

export default async function handler(ctx: Context) {
  return { id: ctx.params.id }; // plain objects auto-serialize to JSON
}
```

## CLI

| Command | Does |
|---|---|
| `anvil init [dir]` | Scaffolds package.json, tsconfig, and starter routes (basic API / MCP server / agent route) |
| `anvil dev` | Dev server, hot reload, TypeScript routes loaded on the fly |
| `anvil build` | Static route manifest + production bundle |
| `anvil start` | Runs the production bundle |
| `anvil lint` | Params/schema validation; MCP-schema serializability (`--strict` fails on warnings too) |
| `anvil mcp [--stdio]` | Serves exposed routes + `server/tools/` as an MCP server |
| `anvil eval <file>` | Runs an eval suite against an agent; non-zero exit on failure |
| `anvil replay <traceId>` | Re-runs a captured trace with mocked model responses |

## Agent routes

```ts
// server/routes/chat/agent.ts
import { defineAgent } from 'anvil-sdk/agent';
import { LlmClient, AnthropicDriver } from 'anvil-sdk/llm';
import { z } from 'zod';

const client = new LlmClient({
  drivers: [new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY })],
  defaultModel: 'claude-opus-4-8',
  fallback: ['gpt-4o'], // add an OpenAIDriver (or 'gemini-2.5-flash' + GeminiDriver)
});

export default defineAgent({
  client,
  system: 'You are a helpful assistant.',
  tools: [
    { name: 'get_weather', description: 'Get weather for a city', zodSchema: z.object({ city: z.string() }), execute: ({ city }) => fetchWeather(city) },
  ],
});
```

Served over `POST`, streaming the **Vercel AI SDK data-stream protocol** (`useChat` works against it directly). The runtime runs the model↔tool loop with an iteration cap, validates each tool's input against its Zod schema, tracks usage/cost, and aborts the whole run — model call and tool execution — on client disconnect.

Add durability, human approval, and policy with a few more options — see **[docs/agents.md](./docs/agents.md)** and **[docs/durability-safety.md](./docs/durability-safety.md)**.

## Why not just Express + an MCP SDK + LangChain?

Because then you're maintaining three schemas for one endpoint (REST validation, tool-calling schema, MCP tool definition), a hand-rolled trace format, your own crash-recovery for agent loops, and a bespoke approval flow for anything that touches money or PII. Anvil's bet: this is framework-layer work, done once, the way Next.js did routing once instead of every app reinventing it.

## Roadmap

A few areas are actively being hardened: deeper static-analysis lint rules for handler bodies, true token-level streaming from the model drivers (currently chunked), an ANN-backed vector store adapter for large corpora, and a container-based sandbox adapter for untrusted code execution.

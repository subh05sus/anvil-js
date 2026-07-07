# Anvil JS

> **Express for humans. Anvil for agents.**

Anvil is a Node.js backend framework for AI & GenAI developers: Express-level flexibility, Next.js-style file-based routing, compile-time route/schema validation, and a native agentic layer — MCP exposure, tool registry, agent orchestration, tracing — built into the framework core.

**Status: pre-alpha.** M0 (core routing engine) and M1 (compile-time validation) are implemented. See [PRD.md](./PRD.md) for the full roadmap.

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

## Roadmap (from PRD)

M0 routing ✅ → M1 compile-time validation → M2 MCP auto-exposure + tool registry → M3 LLM client + agent routes → M4 observability dashboard → M5 durability + HITL + guardrails → M6 evals + prompt registry + replay → M7 memory + RAG → M8 A2A + scheduled agents + sandbox → M9 launch.

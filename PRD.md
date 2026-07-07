# Anvil JS — Product Requirements Document

**The Express.js alternative built for AI & GenAI developers**

Version 0.2 · Owner: Subhadip Saha · Last updated: 2026-07-07

---

## 1. Summary

Anvil JS is a Node.js backend framework that combines Express-level flexibility with Next.js-style file-based routing, full compile-time/build-time type validation, and a native agentic layer — MCP exposure, tool registries, agent orchestration, and observability — built into the framework core rather than bolted on as middleware.

**One-line pitch:** *"Express for humans. Anvil for agents."*

**Positioning:** Not a chatbot template or an AI SDK wrapper. Anvil is a general-purpose HTTP framework where every route is automatically agent-usable, type-safe, and observable — so a developer building a GenAI product doesn't need to hand-wire MCP servers, tool schemas, and LLM clients on top of Express.

---

## 2. Problem Statement

Developers building AI products on Node today stitch together:
- Express/Fastify for HTTP
- A hand-written MCP server (separate codebase, duplicated schemas)
- OpenAI/Anthropic SDKs called ad hoc per route
- Zod for validation, disconnected from tool-calling schemas
- No standard way to trace a multi-step agent run
- No standard way to pause an agent for human approval
- No compile-time guarantee that a route's params, an LLM tool's schema, and the handler code all agree

This results in duplicated schema definitions, untraceable agent failures in production, and no repeatable pattern for shipping agent features safely. Anvil's bet: **the framework layer is the right place to solve this once**, the same way Next.js solved routing/data-fetching once instead of every app reinventing it.

---

## 3. Goals & Non-Goals

### Goals
- Full feature parity with Express (routing, middleware, error handling, static files, sessions, CORS, etc.)
- File-based routing with compile-time validation of routes, params, and schemas
- Zero-extra-code MCP server generation from existing routes
- First-class primitives for agent loops, tool calling, streaming, and human-in-the-loop
- Built-in observability for agent traces (not just HTTP logs)
- Provider-agnostic model client (OpenAI, Anthropic, others) with fallback and cost tracking
- Genuinely good DX: fast dev server, clear errors, strong TypeScript inference throughout
- Crash-safe, resumable agent execution as a framework guarantee, not an app-level pattern
- Speak every relevant agent protocol (MCP and A2A) from one route definition

### Non-Goals (v1)
- Not a no-code/low-code agent builder (no visual canvas)
- Not a hosted platform — Anvil is a self-hosted, open-source framework, not a SaaS
- Not a frontend framework — no opinion on React/Vue/etc., framework-agnostic API layer only
- Not replacing vector databases, model providers, or eval platforms — Anvil integrates with them, doesn't reinvent them

---

## 4. Target Users

| Persona | Need |
|---|---|
| **GenAI product engineer** | Ship an agent feature (chat, copilot, workflow automation) without hand-building MCP/tool infra |
| **Backend dev migrating from Express** | Wants familiar ergonomics + modern conventions + type safety |
| **AI infra/platform engineer** | Needs observability, guardrails, and cost control across many agent routes in one org |
| **Solo/indie hacker** | Wants to ship an MCP server + REST API from the same codebase fast |

---

## 5. Core Framework Features (Express Parity + Modernization)

1. File-based routing under `server/routes/` — folders as path segments, `[param]` dynamic segments, `[...param]` catch-all, `(group)` route groups
2. One file per HTTP verb: `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts`, `options.ts`
3. Scoped middleware via `_middleware.ts`, composed top-down through the folder tree
4. Typed `Context` object (`ctx.req`, `ctx.res`, `ctx.params`, `ctx.query`, `ctx.body`) instead of Express's mutation-heavy `res`
5. Build step generates a static route manifest (like Next's route manifest) — no runtime filesystem scanning in production
6. Compile-time validation via `ts-morph`:
   - Folder param names must match handler `params` types
   - No duplicate/ambiguous routes (static vs dynamic conflicts, including case-insensitive collisions that only surface when moving between Windows and Linux filesystems)
   - Every route folder must have at least one valid method file
   - Zod schema types must match what the handler actually consumes
7. Plugin system for cross-cutting concerns (auth, rate limiting, logging) compatible with existing Express middleware via a compat shim
8. CLI: `anvil dev`, `anvil build`, `anvil start`, `anvil mcp`, `anvil lint`, `anvil eval`, `anvil replay`

---

## 6. Agentic Feature Set

This is Anvil's core differentiator. Grouped by function.

### 6.1 MCP Auto-Exposure
Any route with a schema and `meta.mcp.expose = true` is automatically served as an MCP tool — no separate MCP server codebase.
```ts
export const meta = { mcp: { expose: true, description: "Fetch order by ID" } }
export const paramsSchema = z.object({ id: z.string() })
export default async function handler(ctx) { ... }
```
`anvil mcp` serves all exposed routes over an MCP-compliant server. **Streamable HTTP is the primary transport** (served from the same process as the HTTP app); stdio is supported for local clients such as Claude Desktop.

### 6.2 Agent Routes (`agent.ts`)
A new handler type alongside REST verbs, purpose-built for agent loops: default SSE/WebSocket streaming, abort-signal propagation from client disconnect into the model call, built-in max-iteration guards.

### 6.3 Tool Registry
`server/tools/` — tools defined once, with JSON schema inferred from TypeScript types. The same tool definition powers OpenAI/Anthropic function calling, MCP exposure, A2A exposure, and internal agent-to-agent calls — single source of truth, no duplicated schemas. Tools declare `sideEffect: true` when they mutate external state, which drives checkpoint fencing (§6.20) and permission scoping (§6.14).

### 6.4 Provider-Agnostic Model Client
`ctx.llm.generate(...)` abstracts over model providers with config-driven fallback chains (e.g., Claude → GPT on timeout/error), automatic retries, and per-call usage/cost logging. Implemented as **Anvil's own thin driver abstraction** over the official Anthropic and OpenAI SDKs (not a wrapper around a third-party meta-SDK), so tracing hooks, cost accounting, and abort propagation are first-class rather than bolted on.

### 6.5 Structured Output Enforcement
Routes declare an output schema; Anvil validates LLM structured output against it and auto-retries with the validation error fed back into the prompt before the response reaches handler logic.

### 6.6 Agent Observability & Tracing
Every agent run — including nested tool calls and retries — is captured as a trace tree (model calls, tool calls, latency, token usage, cost). A **bundled local dashboard is served at `/_anvil`** by `anvil dev` (prebuilt static assets, no frontend deps imposed on the user), showing the trace tree, token usage, cost per route, the HITL approval queue, and replay launch. Distinct from standard HTTP access logs. Default storage is local SQLite (`better-sqlite3`) behind a pluggable store adapter.

### 6.7 Human-in-the-Loop Primitive
`ctx.requestApproval(payload)` suspends an agent run and persists its state, resuming from an external event (webhook, dashboard action) — a first-class alternative to hand-rolled state machines. Suspended state persists in the same SQLite-backed state store (Redis/Postgres adapters for scale-out), so approvals survive restarts.

### 6.8 Context Assembly Middleware (`_context.ts`)
A composable pipeline convention scoped to agent routes for RAG context assembly, token-budget trimming, and system-prompt injection — analogous to `_middleware.ts` but for context construction.

### 6.9 Compile-Time Prompt & Agent Linting
Extends the `ts-morph` build pass to flag agent-specific footguns before deploy: unbounded agent loops with no iteration cap, tool definitions missing descriptions, streaming routes with no timeout/abort handling, MCP-exposed routes whose Zod schemas cannot losslessly convert to JSON Schema (see §11).

### 6.10 Session & Memory Store
Built-in pluggable memory backend (SQLite default; Redis or custom adapter) for conversational/agent state, with a typed API (`ctx.memory.get/set/append`) so memory isn't hand-rolled per project.

### 6.11 Semantic Caching
Optional response cache keyed on embedding similarity rather than exact string match, for expensive/repeated LLM calls — configurable per route, with cache-hit visibility in the trace dashboard.

### 6.12 Agent Evals Harness
`anvil eval` runs a project's agent routes against a developer-defined test suite, producing pass/fail + regression diffs. Two assertion classes: **deterministic** (output schema, regex, tool-was-called, cost/latency budgets) and **LLM-as-judge** (rubric-scored, with judge calls themselves traced and cost-tracked like any other model call). Treats agent behavior as testable, versionable code rather than "vibes."

### 6.13 Prompt Registry & Versioning
Prompts stored as first-class versioned artifacts (not inline strings scattered across handlers), with diffing between versions and the ability to pin a route to a specific prompt version — supports safe rollout/rollback of prompt changes independent of code deploys.

### 6.14 Guardrails & Policy Middleware
Declarative policy layer for agent routes: input/output content filtering, PII redaction, and per-tool permission scoping (e.g., a support agent's tools can read orders but not issue refunds without approval) — enforced centrally, not per-handler.

### 6.15 Cost Governor
Per-route and per-user token/cost budget caps, with configurable behavior on breach (block, degrade to cheaper model, or require approval) — surfaced in the same dashboard as tracing. Counts partial usage from aborted streams so disconnects don't create blind spots.

### 6.16 Multi-Agent Orchestration Primitives
Lightweight conventions for agent-to-agent delegation within a project (`ctx.callAgent('routeName', payload)`), so multi-agent systems are composed from the same route/tool primitives rather than a separate orchestration framework.

### 6.17 Sandboxed Code Execution Route Type
An opt-in handler type (`execute.ts`) that runs LLM-generated code in an isolated subprocess with resource limits — for agents that need code-execution tools without developers building sandboxing themselves. **v1 isolation model: subprocess with no network access, a read-only filesystem allowlist, and CPU/memory/timeout limits**, with an optional container adapter for stronger boundaries. Ships with a documented threat model (see §11).

### 6.18 Streaming Protocol Compatibility
Agent routes emit the **Vercel AI SDK data stream protocol** as the native streaming format, so `useChat`/`useCompletion` and the broader AI SDK frontend ecosystem consume Anvil agent routes out of the box — no custom parsing per project.

### 6.19 Replay & Time-Travel Debugging
Given a captured trace, `anvil replay <traceId>` re-runs an agent's exact recorded steps (with mocked model responses) for local debugging of production failures without re-spending on live model calls.

### 6.20 Durable Execution & Checkpointing
Agent runs checkpoint each step — every model call, tool call, and retrieval — to the state store. A crash, redeploy, or process kill mid-run resumes from the last checkpoint instead of restarting (and re-billing) the whole run. Tools marked `sideEffect: true` are checkpoint-fenced: the checkpoint is written before execution, so resume/replay always knows what committed. This extends the HITL persistence machinery (§6.7) into general crash-safety — Temporal-style durability, but framework-native with zero extra infrastructure (SQLite default).

### 6.21 Prompt Injection Defense Layer
Framework-level taint tracking: tool outputs and retrieved documents are marked **untrusted** as they enter the context window. A declarative policy controls what tainted content may trigger — e.g., instructions found in tainted text cannot initiate new tool calls, or can only do so after HITL approval (§6.7). Includes quarantine/strip patterns for known injection vectors. Complements §6.14: guardrails police *content*, this layer polices *provenance*.

### 6.22 RAG Pipeline Primitives
`ctx.retrieve(query, opts)` with pluggable embedder and vector-store adapters — `sqlite-vec` as the zero-config default, pgvector and Qdrant adapters for production. Ships chunking utilities and an ingestion CLI. Every retrieval step appears in the trace tree (§6.6) with the retrieved chunks, so "why did the agent say that" is answerable. Feeds the `_context.ts` assembly pipeline (§6.8).

### 6.23 Scheduled & Event-Triggered Agents
Two new route types for agents that run without an HTTP request: `schedule.ts` (cron expression in `meta.schedule`) and `trigger.ts` (fired by webhooks or queue events). Both run under the same tracing, cost-governor, guardrails, and durability machinery as request-driven agents — background agents are not a governance blind spot.

### 6.24 A2A Protocol Support
Agent routes are exposable via Google's Agent2Agent (A2A) protocol alongside MCP: Anvil generates the agent card from route metadata and maps agent runs onto the A2A task lifecycle (including long-running tasks backed by §6.20 durability). Positioning: **Anvil speaks every agent protocol** — one route definition serves REST, MCP, and A2A.

### 6.25 OpenTelemetry GenAI Export
The trace store (§6.6) exports spans following the OpenTelemetry GenAI semantic conventions, plugging into Datadog, Grafana, Langfuse, Braintrust, and any OTel-compatible backend. Local SQLite for the 5-minute quickstart; OTel export for the enterprise observability stack — same trace tree, two sinks.

---

## 7. Toolchain & Platform Decisions

| Concern | Choice |
|---|---|
| Request/response model | **Web-standard** (Fetch API `Request`/`Response`) core; Node adapter on top; edge adapters possible later |
| Distribution | **Single `anvil` package**, ESM-only, Node ≥ 20; agentic modules via subpath exports (`anvil/mcp`, `anvil/llm`, `anvil/trace`, …) so the kernel stays lean |
| Static analysis / codegen | `ts-morph` |
| Bundling | `esbuild` / `tsup` |
| Dev watch mode | `chokidar`; TS execution in dev via `jiti` |
| Route matching | Custom radix-tree matcher (static > dynamic > catch-all precedence baked into the manifest) |
| Schema validation | `zod` (with build-time JSON-Schema convertibility checks for exposed routes) |
| CLI | `commander` |
| MCP transport | MCP SDK — Streamable HTTP primary, stdio secondary |
| Model providers | Official Anthropic + OpenAI SDKs behind Anvil's own driver interface |
| Tracing / state storage | `better-sqlite3` default for traces, HITL state, memory, checkpoints, prompt versions; Redis/Postgres adapters; OTel exporter |
| Vector store default | `sqlite-vec`; pgvector/Qdrant adapters |
| Streaming format | Vercel AI SDK data stream protocol |
| Framework test infra | Vitest |

---

## 8. Architecture Overview

```
┌─ Compiler (build time) ──────────────────────────────────────┐
│ ts-morph pass over server/routes/** and server/tools/**      │
│  → validates params/schemas/conflicts, agent lint rules      │
│  → emits .gen/routes.ts (static manifest) + .gen/tools.ts    │
└──────────────────────────────────────────────────────────────┘
┌─ Runtime kernel ─────────────────────────────────────────────┐
│ Web-standard Router (Request → Response), radix-tree matcher │
│ Context (params/query/body typed from manifest)              │
│ Middleware composition (onion model), Express compat shim    │
│ Node adapter (http.Server ↔ fetch handler); edge adapters    │
└──────────────────────────────────────────────────────────────┘
┌─ Agentic layer ──────────────────────────────────────────────┐
│ Tool registry · LLM client (drivers: anthropic, openai)      │
│ Agent runtime (loop, iteration caps, abort propagation,      │
│   checkpointing) · MCP server · A2A server · guardrails/     │
│   taint policy · cost governor · semantic cache · retrieval  │
└──────────────────────────────────────────────────────────────┘
┌─ Storage ────────────────────────────────────────────────────┐
│ StoreAdapter iface — SQLite default (traces, HITL, memory,   │
│ checkpoints, prompt versions); Redis/Postgres adapters; OTel │
│ exporter                                                     │
└──────────────────────────────────────────────────────────────┘
┌─ Surfaces ───────────────────────────────────────────────────┐
│ CLI (dev/build/start/mcp/lint/eval/replay) · /_anvil         │
│ dashboard · SSE streaming (AI SDK data stream protocol)      │
└──────────────────────────────────────────────────────────────┘
```

Architectural invariants:
- **Manifest-driven everything.** The router, MCP tool list, A2A agent card, and dashboard route table all read the same generated manifest — single source of truth, no runtime filesystem scanning in production.
- **The kernel has zero agentic imports.** `import anvil` pulls no MCP SDK, sqlite, or LLM SDK code; agentic modules load lazily via subpath exports. Pure-REST users stay lean despite the single-package distribution.
- **Every agentic operation flows through one `TraceContext`.** Model calls, tool calls, retrieval, cache hits, judge calls — one span tree feeds the dashboard, OTel export, replay, and the cost governor.
- **`AbortSignal` is threaded end-to-end.** From client disconnect through the agent loop into model and tool calls — enforced by an agent-lint rule, not left to convention.

---

## 9. Success Metrics (v1 launch)

- Time-to-first-working-MCP-server from a fresh Anvil project: **under 5 minutes**
- Zero manual schema duplication between REST route, tool definition, and MCP/A2A exposure for a given route
- Full Express-parity checklist (routing, middleware, error handling, static serving) passes
- Working dashboard showing at least: trace tree, token usage, cost per route
- An agent run killed mid-execution resumes from its last checkpoint with no duplicated side-effect tool calls
- Open-source launch: README, docs site, and 3+ example apps (basic API, MCP server, agent with HITL)

---

## 10. Milestones

1. **M0 — Core routing engine** ✅: filesystem scanner, manifest generation, web-standard kernel (router, context, middleware, Node adapter), CLI dev/build/start, Express-parity basics
2. **M1 — Compile-time validation** ✅: `anvil lint` — param/schema key consistency, Zod→JSON-Schema convertibility checks (edge #2), MCP-exposure description warnings; scanner conflict/collision checks surfaced as diagnostics. (Deeper ts-morph handler-body analysis — e.g. `ctx.params.x` usage vs declared params — deferred to a later pass.)
3. **M2 — MCP auto-exposure + tool registry** ✅: `anvil mcp` (Streamable HTTP + stdio), JSON-RPC server (initialize/tools.list/tools.call), tool registry from `meta.mcp.expose` routes + `server/tools/`, JSON-Schema inference via the M1 converter, Zod re-validation on call. (Protocol logic isolated behind the transport adapter per §11.)
4. **M3 — Model client + agent routes** ✅: (M3-A) `LlmClient` driver abstraction (Anthropic/OpenAI/mock drivers, fallback chains, transient retries, cost tracking, trace hook, structured-output enforcement via Zod repair loop). (M3-B) tool-calling in the model layer, `runAgent`/`streamAgent` loop with tool execution + iteration caps + abort, `agent.ts` route type (scanner → POST), Vercel AI SDK data stream protocol, `withLlm`/`getLlm` context wiring, client-disconnect abort threaded from the Node adapter into model/tool calls.
5. **M4 — Observability** ✅: trace model + span tree (`Tracer`), pluggable `TraceStore` (in-memory default, lazy SQLite adapter), cost governor with budget caps, agent runtime records agent/model/tool spans and enforces budgets, bundled `/_anvil` dashboard (trace tree, tokens, cost per route), OTel GenAI-convention export via the tracer's `onExport` seam.
6. **M5 — Durability + safety** ✅: pluggable `StateStore` (memory default, lazy SQLite), durable per-step checkpointing with side-effect fencing, HITL `meta.requestApproval` suspend + `resumeAgent` with injected approval, guardrails (content filter, PII redaction, per-tool permission scoping) and a prompt-injection taint layer that gates tool calls made from untrusted-content context — a `deny` becomes an error tool result, an `approve` routes through the same HITL suspend/resume.
7. **M6 — Evals + prompt registry + replay** ✅: `PromptRegistry` (versioned prompts, diff, pin, `renderPrompt`), evals harness (`anvil eval` — deterministic assertions + LLM-as-judge), and replay — traces record model responses + tool outputs, and `anvil replay <traceId>` re-runs the agent loop with a `ReplayDriver` and synthesized tools (no live model calls, no re-fired side effects).
8. **M7 — Memory + retrieval** ✅: `MemoryStore` (`ctx.memory` over the state store, namespaced per session), RAG primitives (`Embedder`/`HashEmbedder`, `VectorStore`/`MemoryVectorStore`/lazy `SqliteVectorStore`, `chunkText`, traced `Retriever`), `SemanticCache` (embedding-similarity response cache with hit/miss trace spans, §6.11), and the `_context.ts` assembly pipeline (`assembleContext` with retrieval/token-budget/system-injection steps, wired into `defineAgent`, §6.8).
9. **M8 — Protocol + background surface** ✅: scheduled agents (`Scheduler`/`cronMatches`), event-triggered agents (`TriggerRegistry`), `loadBackgroundTasks`, multi-agent orchestration (`AgentRegistry`, `agentAsTool`, `callAgent`), A2A protocol server (agent card + `message/send` + `tasks/get`, `a2aHttpHandler`), and a sandboxed `execute` primitive (`worker_threads` + `node:vm`: no require/process/fetch, memory cap + timeout) shipped with a documented threat model — network isolation deferred to the container adapter.
10. **M9 — Public launch**: docs site, 3+ examples, marketing site, positioning as "Express alternative for AI/GenAI devs"

---

## 11. Risks & Edge Cases

- **Route-manifest divergence across filesystems.** Windows is case-insensitive, Linux is not: `routes/Users/` vs `routes/users/` builds fine on a Windows dev machine and breaks on Linux prod. *Mitigation:* the compiler normalizes and compares route paths case-insensitively on all hosts and hard-errors on collision; specificity ordering (static > dynamic > catch-all) is baked into the manifest; CI runs on both ubuntu and windows.
- **Non-serializable Zod schemas silently corrupt MCP/A2A exposure.** `z.transform()`, `.refine()`, `z.lazy()` don't fully convert to JSON Schema, so an exposed tool would advertise a wrong schema with no build error. *Mitigation:* build-time convertibility check — lossy constructs on exposed routes are a compile error with a fix-it message; runtime still re-validates with the original Zod schema.
- **Client disconnect mid-agent-loop leaks cost, state, and half-done side effects.** *Mitigation:* `AbortSignal` threaded through model and tool calls (lint-enforced); trace spans finalize in `finally` with status `aborted`; `sideEffect: true` tools are checkpoint-fenced; the cost governor counts partial streamed usage.
- **MCP/A2A spec stability**: both protocols are evolving; transport/spec changes could require rework — isolate protocol logic behind adapter layers.
- **Scope**: all of §6 is committed roadmap, built strictly milestone-by-milestone (§10) — each milestone is independently shippable and useful.
- **Adoption risk**: Express's dominance is inertia-driven; positioning must lead with the AI-agent differentiation, not "yet another Express clone."
- **Sandboxed execution (§6.17)** carries real security surface — requires its own threat model before shipping (scheduled inside M8, not earlier).
- **npm package name**: `anvil` is likely taken on npm; final published name TBD before M2.

---

## 12. Competitive Landscape (brief)

- **Express/Fastify**: mature, ubiquitous, zero agent-native tooling.
- **Hono**: modern, edge-first, fast — no agent/MCP-specific layer.
- **Next.js API routes**: routing convention inspiration, but not a standalone backend framework and no agent tooling.
- **tRPC**: strong type-safety story, no MCP/agent observability layer.
- **LangChain/LlamaIndex**: agent orchestration libraries, not HTTP frameworks — Anvil could interoperate with these rather than compete directly.
- **Temporal/Inngest**: durable execution platforms — Anvil offers the 80% case (checkpointed agent runs) with zero extra infrastructure.

Anvil's wedge: no existing framework treats "this route is also an MCP tool, also an A2A agent, also traced, also cost-governed, also crash-resumable" as a first-class, zero-boilerplate framework feature.

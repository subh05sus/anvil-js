# Observability

Every agent run is captured as a trace tree — agent/model/tool/retrieval/cache spans, each with token usage and cost — separate from ordinary HTTP access logs.

## Tracing an agent route

```ts
import { Tracer, MemoryTraceStore } from 'anvil-js/trace';

const tracer = new Tracer(new MemoryTraceStore()); // or await SqliteTraceStore.open() to persist

export default defineAgent({ client, tracer });
```

A trace opens per request and closes when the stream ends (`ok` / `error` / `aborted`).

## The dashboard

```ts
import { dashboardMiddleware } from 'anvil-js/trace';
// in a root server/routes/_middleware.ts:
export default [dashboardMiddleware(traceStore), /* ...other middleware */];
```

Serves a self-contained page at `/_anvil` (trace list, span tree, tokens, cost — auto-refreshing) plus a small JSON API (`/_anvil/api/traces`, `/_anvil/api/traces/:id`) with no external assets or frontend framework required.

## Cost governor

```ts
import { CostGovernor } from 'anvil-js/trace';

export default defineAgent({ client, budget: { maxUsd: 0.50 } }); // throws BudgetExceededError once spend crosses the cap
```

Spend accumulates across the run's model calls (including partial usage from an aborted stream, so a disconnect doesn't create a blind spot) and is checked before every model call.

## OpenTelemetry export

```ts
import { otlpHttpExporter } from 'anvil-js/trace';

const tracer = new Tracer(traceStore, {
  onExport: otlpHttpExporter({ url: 'https://collector.example/v1/traces' }),
});
```

Spans map to OTLP following the OpenTelemetry **GenAI semantic conventions** (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.tool.name`) — plugs into Datadog, Grafana, Langfuse, or any OTLP-compatible backend, alongside the local dashboard.

## SQLite persistence

`MemoryTraceStore` (zero-dep, default) loses history on restart. For a persistent store:

```ts
import { SqliteTraceStore } from 'anvil-js/trace';
const traceStore = await SqliteTraceStore.open('.anvil/traces.db'); // requires better-sqlite3 (optional peer dep)
```

The same file also backs `anvil replay <traceId>` — see [evals, prompts & replay](./evals-prompts-replay.md).

# Protocol & background agents

## Scheduled agents

```ts
// server/schedule/nightly-report/schedule.ts
import { defineSchedule } from 'anvil-sdk/schedule';

export default defineSchedule({
  name: 'nightly-report',
  cron: '0 6 * * *', // 5-field cron: minute hour day-of-month month day-of-week
  run: async (ctx) => { /* ctx.now, ctx.trace */ },
});
```

```ts
import { Scheduler, loadBackgroundTasks } from 'anvil-sdk/schedule';

const { schedules } = await loadBackgroundTasks('server/schedule');
const scheduler = new Scheduler({ tracer });
schedules.forEach((s) => scheduler.add(s));
scheduler.start(); // polls every minute; each due task runs once, wrapped in a trace, failures isolated
```

## Event-triggered agents

```ts
// server/triggers/order-created/trigger.ts
import { defineTrigger } from 'anvil-sdk/schedule';
export default defineTrigger({ name: 'order.created', run: async (ctx) => { /* ctx.payload */ } });
```

```ts
import { TriggerRegistry } from 'anvil-sdk/schedule';
const triggers = new TriggerRegistry({ tracer }).register(orderCreatedTrigger);
await triggers.fire('order.created', webhookPayload); // from any webhook handler
```

Both run under the same tracing as request-driven agents — background work isn't a governance blind spot.

## Running background agents — `anvil serve`

`anvil serve` discovers `schedule.ts` / `trigger.ts` files, starts the scheduler, and exposes an authenticated webhook to fire triggers:

```bash
anvil serve                                   # scans ./server, webhook on :3200
anvil serve --dir server --token $SECRET      # require a bearer token to fire triggers
anvil serve --trace memory --interval 30000   # in-memory traces, 30s poll
```

```bash
# Fire a trigger (bearer token required when --token/ANVIL_TRIGGER_TOKEN is set):
curl -X POST http://localhost:3200/triggers/order.created \
  -H "authorization: Bearer $SECRET" -d '{"id":"A-1"}'
```

Scheduled tasks are de-duplicated per minute, and — when a trace/state store is configured — a restart within the same minute won't re-fire a task that already ran. SIGINT/SIGTERM shut the runner down gracefully.

## Multi-agent orchestration

See [agents.md](./agents.md#multi-agent) — `AgentRegistry`, `agentAsTool`, `callAgent`.

## A2A (Agent2Agent)

```ts
import { A2AServer, a2aHttpHandler } from 'anvil-sdk/a2a';

const server = new A2AServer({
  registry,                                  // an AgentRegistry
  name: 'My Agent', description: '...', url: 'https://my-app.example/a2a',
});
export default { fetch: a2aHttpHandler(server) }; // mount as a route, or standalone
```

Serves the agent card at `/.well-known/agent-card.json` and JSON-RPC (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`) at `/a2a`. `message/stream` returns Server-Sent Events (task status + artifact deltas) mapped from the agent's event stream; a client disconnect or `tasks/cancel` aborts the underlying run. Tasks persist through a `StateStore` (`store` option, in-memory by default) so they survive a restart, with TTL + max-count eviction. The same `AgentRegistry` definitions serve REST, MCP, and A2A — one agent, three protocols.

## Sandboxed execution

```ts
import { runSandboxed } from 'anvil-sdk/sandbox';

const result = await runSandboxed('input.a + input.b', { globals: { input: { a: 2, b: 3 } }, timeoutMs: 1000 });
// { ok: true, value: 5, logs: [...] }
```

Runs in a `worker_threads` Worker inside a fresh `node:vm` context — no `require`, `process`, or `fetch`. Memory-capped and timeout-terminated.

**Threat model:** this is in-process isolation, not a security boundary for untrusted code. Network egress is not reliably blocked at this layer. For agent-generated code from untrusted input, run behind a container-based adapter (separate process, no shared network namespace) — this primitive is the ergonomic default for trusted/first-party code, not a sandbox for adversarial input.

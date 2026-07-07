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

Serves the agent card at `/.well-known/agent-card.json` and JSON-RPC (`message/send`, `tasks/get`) at `/a2a`. The same `AgentRegistry` definitions serve REST, MCP, and A2A — one agent, three protocols.

## Sandboxed execution

```ts
import { runSandboxed } from 'anvil-sdk/sandbox';

const result = await runSandboxed('input.a + input.b', { globals: { input: { a: 2, b: 3 } }, timeoutMs: 1000 });
// { ok: true, value: 5, logs: [...] }
```

Runs in a `worker_threads` Worker inside a fresh `node:vm` context — no `require`, `process`, or `fetch`. Memory-capped and timeout-terminated.

**Threat model:** this is in-process isolation, not a security boundary for untrusted code. Network egress is not reliably blocked at this layer. For agent-generated code from untrusted input, run behind a container-based adapter (separate process, no shared network namespace) — this primitive is the ergonomic default for trusted/first-party code, not a sandbox for adversarial input.

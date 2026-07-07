# Durability & safety

## Durable checkpointing

An agent run checkpoints after every completed iteration. A crash or redeploy resumes from the last step instead of restarting (and re-billing) the whole run:

```ts
import { SqliteStateStore } from 'anvil-js/store'; // or MemoryStateStore for tests

export default defineAgent({
  client,
  checkpoint: { store: stateStore, getRunId: (ctx) => ctx.headers.get('x-run-id')! },
});
```

Tool calls marked `sideEffect: true` are fenced by the checkpoint: their result is recorded, so a resume never re-executes the side effect (no double refund, no double email).

## Human-in-the-loop

A tool suspends the run by calling `meta.requestApproval(payload)`:

```ts
const refund: AgentTool = {
  name: 'refund',
  sideEffect: true,
  zodSchema: z.object({ orderId: z.string(), amount: z.number() }),
  execute: (input, meta) => {
    meta.requestApproval(input);       // throws — suspends here
    return processRefund(input);       // only runs after an approved resume
  },
};
```

The run persists a `suspended` checkpoint and streams a `suspended` data-stream part with a `callId`. Resume it with the human's decision:

```ts
import { resumeAgent } from 'anvil-js/agent';

for await (const event of resumeAgent({ client, tools: [refund], checkpoint: { store, runId }, approval: { approved: true } })) { /* ... */ }
```

The approved value is injected as the tool's result — `execute()` is **not** re-run. See [`examples/agent-hitl`](../examples/agent-hitl) for a full request/response walkthrough.

## Guardrails

```ts
import { contentFilter, redactPII, toolPolicy, injectionGuard } from 'anvil-js/agent';

export default defineAgent({
  client,
  guardrails: [
    redactPII(),                                                  // scrub email/card/SSN/phone from output
    toolPolicy({ allow: ['read_order'], requireApproval: ['refund'] }),
    injectionGuard({ mode: 'approve', allowlist: ['read_order'] }), // gate tools once untrusted content is in context
  ],
});
```

`toolPolicy` scopes what a tool can do without human sign-off. `injectionGuard` is a **prompt-injection defense**: once a tool result or retrieved document has entered the conversation, further tool calls are treated as potentially injection-driven and gated — `deny` returns an error result, `approve` routes through the same HITL suspend/resume machinery above. It polices *provenance*; `contentFilter`/`redactPII` police *content*.

## State store

Everything above sits on one pluggable `StateStore` (`anvil/store`): `MemoryStateStore` (default, zero deps) or `SqliteStateStore` (persists to disk, optional `better-sqlite3` peer dependency). The same store backs checkpoints, the [memory store](./memory-rag.md), and the [prompt registry](./evals-prompts-replay.md).

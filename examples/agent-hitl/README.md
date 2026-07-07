# Anvil example: agent with human-in-the-loop

Demonstrates PRD §6.7 (HITL) and §6.20 (durable checkpointing): a `refund` tool
that must not fire without a human's approval, and survives a server restart
while waiting.

## Run it

```bash
npm install
npm run dev
```

## Try it

**1. Ask the agent to issue a refund** — the tool calls `meta.requestApproval(...)`, which suspends the run:

```bash
curl -s -X POST http://localhost:3000/support -H 'content-type: application/json' \
  -d '{"runId":"run-1","messages":[{"role":"user","content":"refund order A-100, the item arrived broken"}]}'
```

The response streams a `suspended` data-stream part with a `callId` and the refund payload — the run is now parked in the shared `StateStore`, not lost. This example uses `MemoryStateStore` (zero native deps, so it runs everywhere); swap in `await SqliteStateStore.open('.anvil/state.db')` from `anvil/store` to persist checkpoints across a server restart — the agent code doesn't change, only `server/state.ts`.

**2. Approve (or deny) it** — a second endpoint resumes the run with the human's decision:

```bash
curl -s -X POST http://localhost:3000/support/approve -H 'content-type: application/json' \
  -d '{"runId":"run-1","approved":true,"amount":42.00}'
```

`resumeAgent` loads the checkpoint, injects the approval as the tool's result (the tool's `execute()` — the part that would actually move money — is **never re-run**), and the agent finishes with a confirmation message.

## What to look at

- `server/routes/support/agent.ts` — the agent route; `refund` is `sideEffect: true` and calls `meta.requestApproval(...)` before doing anything.
- `server/routes/support/approve/post.ts` — loads the checkpoint via `resumeAgent({ checkpoint, approval })`.
- `server/state.ts` — the shared `SqliteStateStore` both routes use, so suspend (write) and approve (read) see the same checkpoint.

This is the same primitive that backs "approve this $10k transfer" or "review this email before it sends" — the tool decides when a human is required; the framework handles suspend/resume/never-double-execute.

# Evals, prompt registry & replay

## Evals

```ts
import { defineEvalSuite, agentRunner, outputContains, toolCalled, maxCost, judge } from 'anvil-js/eval';

export default defineEvalSuite({
  name: 'support agent',
  runner: agentRunner({ client, tools }),
  cases: [
    {
      name: 'answers with a tool call',
      input: 'where is my order?',
      assert: [toolCalled('lookup_order'), outputContains('shipped'), maxCost(0.05)],
    },
    {
      name: 'stays on brand',
      input: 'what do you think of our competitor?',
      assert: [judge({ client, rubric: 'Does not disparage competitors; stays factual.' })],
    },
  ],
});
```

```bash
anvil eval evals/support.eval.ts
```

Deterministic assertions: `outputContains`/`outputMatches`, `toolCalled`, `maxCost`, `maxIterations`, `outputJson(schema)`. `judge(...)` runs an LLM-as-judge check through the same `LlmClient` — it's traced and cost-tracked like any other call, not a side-channel. Exits non-zero on any failure — wire it into CI.

## Prompt registry

```ts
import { PromptRegistry, renderPrompt } from 'anvil-js/prompt';

const registry = new PromptRegistry(stateStore);
await registry.register('support-system', 'You are a support agent. Be concise.');
await registry.register('support-system', 'You are a support agent. Be concise and cite order numbers.');

const latest = await registry.get('support-system');        // newest version
const pinned = await registry.get('support-system', 1);     // pin a route to a known-good version
const diff = await registry.diff('support-system', 1, 2);   // line-level added/removed
```

Prompts are immutable, versioned artifacts — roll a prompt change forward or back independent of a code deploy, and diff what changed between versions.

## Replay

Every agent span records its input/response; every tool span records its output. `anvil replay` reconstructs and re-runs a captured trace with **zero live model calls and no re-fired side effects**:

```bash
anvil replay <traceId> --store .anvil/traces.db
```

Useful for debugging a production failure locally without spending on the live model, and as a sanity check that a trace store's history is faithful.

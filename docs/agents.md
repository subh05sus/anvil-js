# Agents

## The model client

`LlmClient` (from `anvil/llm`) is a provider-agnostic wrapper over the official Anthropic, OpenAI, and Google Gemini SDKs (loaded lazily — install only the one you use):

```ts
import { LlmClient, AnthropicDriver, OpenAIDriver } from 'anvil-js/llm';

const client = new LlmClient({
  drivers: [new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY }), new OpenAIDriver({ apiKey: process.env.OPENAI_API_KEY })],
  defaultModel: 'claude-opus-4-8',
  fallback: ['gpt-4o'],   // tried on a transient failure of the primary
  maxRetries: 2,
  onTrace: (event) => { /* every call — feeds the tracing pipeline, see observability.md */ },
});

const result = await client.generate({ messages: [{ role: 'user', content: 'hi' }] });
const { object } = await client.generateObject(req, mySchema); // structured output, auto-repaired on validation failure
```

Use `MockDriver` (from `anvil/llm`) for tests and demos — deterministic, scriptable, no API key required.

## Agent routes

```ts
// server/routes/chat/agent.ts
import { defineAgent } from 'anvil-js/agent';

export default defineAgent({
  client,
  system: 'You are a helpful assistant.',
  tools: [
    { name: 'get_weather', description: '...', zodSchema: z.object({ city: z.string() }), execute: ({ city }) => fetchWeather(city) },
  ],
  maxIterations: 10,        // hard cap on model↔tool turns
});
```

`agent.ts` is served over `POST`, streaming the **Vercel AI SDK data-stream protocol** — `useChat` works against it out of the box. Client disconnect aborts both the model call and any in-flight tool execution.

## The loop, directly

```ts
import { runAgent, streamAgent } from 'anvil-js/agent';

const result = await runAgent({ client, messages, tools });
// or, to observe events live:
for await (const event of streamAgent({ client, messages, tools })) { /* iteration | text | tool_call | tool_result | final | error */ }
```

Each tool call's input is validated against its `zodSchema` before `execute` runs; validation failures come back as an error tool-result the model can react to, not a crash.

## Context assembly

```ts
import { assembleContext, retrievalContext, tokenBudget, systemContext } from 'anvil-js/agent';

export default defineAgent({
  client,
  context: [systemContext('Be concise.'), retrievalContext(retriever, { topK: 4 }), tokenBudget({ maxTokens: 8000 })],
});
```

See [memory & retrieval](./memory-rag.md) for `Retriever` and `SemanticCache`.

## Multi-agent

```ts
import { AgentRegistry, agentAsTool, callAgent, withAgents } from 'anvil-js/agent';

const registry = new AgentRegistry().register('researcher', { client, system: '...' });
const orchestrator = defineAgent({ client, tools: [agentAsTool(registry, 'researcher')] });
// or, from any handler: await callAgent(ctx, 'researcher', 'look into X')  (needs withAgents(registry) middleware)
```

See [durability & safety](./durability-safety.md) for checkpointing, human-in-the-loop, and guardrails, and [protocol & background agents](./protocol-background.md) for A2A and scheduled/triggered agents.

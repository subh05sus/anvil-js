import { defineAgent } from 'anvil/agent';
import { LlmClient, MockDriver } from 'anvil/llm';
import { z } from 'zod';
import { USERS } from '../users/data';

// A demo agent. Uses the MockDriver so it runs with no API key; swap in
// `new AnthropicDriver({ apiKey })` for a real model. `anvil dev` mounts this
// agent.ts as POST /chat, streaming the Vercel AI SDK data stream protocol.
const client = new LlmClient({
  drivers: [
    new MockDriver({
      prefix: 'claude',
      defaultText: 'I can look up users — try asking me to find user 1.',
    }),
  ],
  defaultModel: 'claude-opus-4-8',
});

export default defineAgent({
  client,
  system: 'You are a helpful assistant for the Anvil example API.',
  tools: [
    {
      name: 'get_user',
      description: 'Look up a user by id',
      zodSchema: z.object({ id: z.string() }),
      execute: ({ id }) => USERS.find((u) => u.id === id) ?? { error: 'not found' },
    },
  ],
});

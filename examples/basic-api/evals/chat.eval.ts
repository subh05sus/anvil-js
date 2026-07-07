import { agentRunner, defineEvalSuite, outputContains } from 'anvil-sdk/eval';
import { LlmClient, MockDriver } from 'anvil-sdk/llm';

// Uses the MockDriver so `anvil eval` runs with no API key. Swap in a real
// driver to evaluate against a live model.
const client = new LlmClient({
  drivers: [new MockDriver({ prefix: 'claude', defaultText: 'I can look up users — try asking me to find user 1.' })],
  defaultModel: 'claude-opus-4-8',
});

export default defineEvalSuite({
  name: 'chat agent',
  runner: agentRunner({ client, system: 'You are a helpful assistant.' }),
  cases: [
    { name: 'offers to look up users', input: 'what can you do?', assert: [outputContains('look up users')] },
  ],
});

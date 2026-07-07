import { HttpError, type Context } from 'anvil-sdk';
import { defineAgent, type AgentTool } from 'anvil-sdk/agent';
import { LlmClient, MockDriver } from 'anvil-sdk/llm';
import { z } from 'zod';
import { stateStore } from '../../state';

// MockDriver so this runs with no API key. In iteration 1 it "decides" to
// issue a refund; in iteration 2 (after resume) it confirms.
const client = new LlmClient({
  drivers: [
    new MockDriver({
      prefix: 'claude',
      script: [
        { text: 'Let me process that refund for you.', toolCalls: [{ id: 'refund-1', name: 'refund', input: { orderId: 'A-100', amount: 42 } }] },
        { text: 'Done — your refund has been issued.' },
      ],
    }),
  ],
  defaultModel: 'claude-opus-4-8',
});

const refund: AgentTool = {
  name: 'refund',
  description: 'Issue a refund for an order. Requires human approval.',
  zodSchema: z.object({ orderId: z.string(), amount: z.number() }),
  sideEffect: true,
  execute: (input, meta) => {
    const { orderId, amount } = input as { orderId: string; amount: number };
    // Suspend the run until a human approves — this line throws, and the
    // code below never executes until resumeAgent injects an approval.
    meta.requestApproval({ orderId, amount });
    // In a real integration this is where money actually moves. Because
    // requestApproval throws, this only runs once — on resume, the approved
    // result is injected and this execute() body is NOT re-entered.
    return { refunded: true, orderId, amount };
  },
};

export default defineAgent({
  client,
  system: 'You are a support agent. Use the refund tool for refund requests.',
  tools: [refund],
  checkpoint: {
    store: stateStore,
    getRunId: (ctx: Context) => ctx.state.runId as string,
  },
  async getMessages(ctx: Context) {
    const body = await ctx.body<{ runId?: string; messages?: unknown }>();
    if (!body.runId) throw new HttpError(400, 'Expected a JSON body with "runId" and "messages"');
    // Stash the runId so `checkpoint.getRunId` (above) can read it — getMessages
    // always runs before the checkpoint is resolved.
    ctx.state.runId = body.runId;
    const raw = body.messages;
    if (!Array.isArray(raw)) throw new HttpError(400, 'Expected "messages" to be an array');
    return raw as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  },
});

import { HttpError, type Context } from 'anvil-sdk';
import { resumeAgent, type AgentTool } from 'anvil-sdk/agent';
import { LlmClient, MockDriver } from 'anvil-sdk/llm';
import { z } from 'zod';
import { stateStore } from '../../../state';

// Same driver shape as the agent route: after resume, the model just confirms.
const client = new LlmClient({
  drivers: [new MockDriver({ prefix: 'claude', defaultText: 'Done — your refund has been issued.' })],
  defaultModel: 'claude-opus-4-8',
});

// The tool must be redeclared here (same name) so the resumed loop has a
// definition to advertise to the model — its execute() is never called for
// the fenced/approved call.
const refund: AgentTool = {
  name: 'refund',
  description: 'Issue a refund for an order. Requires human approval.',
  zodSchema: z.object({ orderId: z.string(), amount: z.number() }),
  sideEffect: true,
  execute: () => {
    throw new Error('unreachable: the approved call is fenced by the checkpoint, not re-executed');
  },
};

export default async function handler(ctx: Context) {
  const body = await ctx.body<{ runId?: string; approved?: boolean; amount?: number }>();
  if (!body.runId) throw new HttpError(400, 'Expected a JSON body with "runId"');

  const decision = body.approved ? { refunded: true, amount: body.amount } : { refunded: false, reason: 'denied by support agent' };

  const gen = resumeAgent({
    client,
    tools: [refund],
    checkpoint: { store: stateStore, runId: body.runId },
    approval: decision,
  });
  let next = await gen.next();
  while (!next.done) next = await gen.next();
  const result = next.value;

  return ctx.json({ runId: body.runId, text: result.text, iterations: result.iterations });
}

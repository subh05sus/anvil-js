import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LlmClient } from '../src/llm/client.js';
import { MockDriver, type MockDriverOptions } from '../src/llm/drivers/mock.js';
import type { AgentTool } from '../src/agent/runtime.js';
import {
  agentRunner,
  defineEvalSuite,
  judge,
  maxCost,
  maxIterations,
  outputContains,
  outputJson,
  outputMatches,
  runSuite,
  toolCalled,
} from '../src/eval/index.js';

const client = (options: Omit<MockDriverOptions, 'prefix'>) =>
  new LlmClient({ drivers: [new MockDriver({ prefix: 'claude', ...options })], defaultModel: 'claude-opus-4-8' });

describe('runSuite (deterministic assertions)', () => {
  it('passes a case whose output and tool use satisfy all assertions', async () => {
    const weather: AgentTool = { name: 'get_weather', description: 'w', execute: () => ({ tempC: 21 }) };
    const c = client({
      script: [
        { text: '', toolCalls: [{ id: 't1', name: 'get_weather', input: { city: 'Paris' } }] },
        { text: 'It is 21C in Paris.' },
      ],
    });
    const suite = defineEvalSuite({
      name: 'weather',
      runner: agentRunner({ client: c, tools: [weather] }),
      cases: [
        {
          name: 'answers with tool',
          input: 'weather in Paris?',
          assert: [outputContains('21C'), toolCalled('get_weather'), maxIterations(3), maxCost(1)],
        },
      ],
    });
    const report = await runSuite(suite);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.cases[0]!.assertions.every((a) => a.pass)).toBe(true);
  });

  it('reports failing assertions with messages', async () => {
    const c = client({ defaultText: 'no idea' });
    const report = await runSuite(
      defineEvalSuite({
        name: 'strict',
        runner: agentRunner({ client: c }),
        cases: [{ name: 'wants answer', input: 'q', assert: [outputContains('42'), outputMatches(/answer/)] }],
      }),
    );
    expect(report.failed).toBe(1);
    const failed = report.cases[0]!.assertions.filter((a) => !a.pass);
    expect(failed).toHaveLength(2);
    expect(failed[0]!.message).toContain('no idea');
  });

  it('validates JSON output against a schema', async () => {
    const c = client({ defaultText: '{"city":"Rome","pop":3}' });
    const report = await runSuite(
      defineEvalSuite({
        name: 'json',
        runner: agentRunner({ client: c }),
        cases: [{ name: 'structured', input: 'q', assert: [outputJson(z.object({ city: z.string(), pop: z.number() }))] }],
      }),
    );
    expect(report.passed).toBe(1);
  });
});

describe('runSuite (LLM judge)', () => {
  it('uses a model to score output against a rubric', async () => {
    const agent = client({ defaultText: 'The capital of France is Paris.' });
    const judgeClient = client({ defaultText: '{"pass": true, "reason": "correct and complete"}' });
    const report = await runSuite(
      defineEvalSuite({
        name: 'judged',
        runner: agentRunner({ client: agent }),
        cases: [{ name: 'accurate', input: 'capital of France?', assert: [judge({ client: judgeClient, rubric: 'States that Paris is the capital.' })] }],
      }),
    );
    expect(report.passed).toBe(1);
    expect(report.cases[0]!.assertions[0]!.message).toBe('correct and complete');
  });

  it('fails the case when the judge returns pass:false', async () => {
    const agent = client({ defaultText: 'The capital of France is Berlin.' });
    const judgeClient = client({ defaultText: '{"pass": false, "reason": "factually wrong"}' });
    const report = await runSuite(
      defineEvalSuite({
        name: 'judged',
        runner: agentRunner({ client: agent }),
        cases: [{ name: 'accurate', input: 'capital?', assert: [judge({ client: judgeClient, rubric: 'Paris is the capital.' })] }],
      }),
    );
    expect(report.failed).toBe(1);
    expect(report.cases[0]!.assertions[0]!.message).toBe('factually wrong');
  });
});

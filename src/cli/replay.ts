import { replayToResult } from '../agent/replay.js';
import { SqliteTraceStore } from '../trace/sqlite-store.js';

export interface ReplayCliOptions {
  traceId: string;
  /** SQLite trace DB file (written by a tracer using SqliteTraceStore). */
  store: string;
}

export async function replayCommand(options: ReplayCliOptions): Promise<void> {
  let store: SqliteTraceStore;
  try {
    store = await SqliteTraceStore.open(options.store);
  } catch (err) {
    console.error(`[anvil] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  const trace = await store.getTrace(options.traceId);
  if (!trace) {
    console.error(`[anvil] no trace "${options.traceId}" in ${options.store}`);
    process.exitCode = 1;
    return;
  }

  console.log(`[anvil] replaying ${trace.name} (${options.traceId}) — mocked model, no live calls\n`);
  const { events } = await replayToResult(trace);
  for (const e of events) {
    switch (e.type) {
      case 'iteration':
        console.log(`— iteration ${e.n}`);
        break;
      case 'text':
        if (e.text) console.log(`assistant: ${e.text}`);
        break;
      case 'tool_call':
        console.log(`tool_call: ${e.name}(${JSON.stringify(e.input)})`);
        break;
      case 'tool_result':
        console.log(`tool_result: ${e.name} → ${JSON.stringify(e.output)}`);
        break;
      case 'final':
        console.log(`\n[anvil] replay complete (${e.iterations} iteration(s))`);
        break;
    }
  }
}

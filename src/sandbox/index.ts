import { Worker } from 'node:worker_threads';

/**
 * Sandboxed code execution (PRD §6.17) — for agents that need a code-execution
 * tool without the developer building isolation themselves.
 *
 * Isolation model (v1, in-process): the code runs in a `worker_threads` Worker,
 * inside a fresh `node:vm` context with NO `require`, `process`, `fetch`, or
 * module access. Memory is capped via the worker's `resourceLimits`, and a
 * wall-clock timeout terminates the worker.
 *
 * ⚠️ THREAT MODEL — read before enabling for untrusted code:
 *  - Network egress is NOT reliably blocked in-process. Node globals like
 *    `fetch` are withheld from the vm context, but a determined payload could
 *    still reach the network through V8/native edge cases. For untrusted code,
 *    run behind the container adapter (separate process + network namespace),
 *    which is the intended production isolation boundary.
 *  - Filesystem: no `fs`/`require` is exposed, so there is no file access from
 *    the vm context by default.
 *  - CPU/timeout: enforced by terminating the worker; a tight native loop may
 *    still consume a core until termination lands.
 *  - This primitive is opt-in and experimental. Do not expose it to untrusted
 *    input without the container adapter and a reviewed policy.
 */
export interface SandboxOptions {
  /** Wall-clock timeout in ms. Default 1000. */
  timeoutMs?: number;
  /** Max old-generation heap (MB) for the worker. Default 64. */
  memoryMb?: number;
  /** Extra read-only globals exposed to the code (must be structured-cloneable). */
  globals?: Record<string, unknown>;
}

export interface SandboxResult {
  ok: boolean;
  /** Completion value of the script (last expression), if any. */
  value?: unknown;
  error?: string;
  logs: string[];
  timedOut: boolean;
}

/**
 * Run `code` in an isolated worker. The script's completion value (its last
 * expression) is returned as `value`; `console.log` output is captured in
 * `logs`.
 */
export function runSandboxed(code: string, options: SandboxOptions = {}): Promise<SandboxResult> {
  const timeoutMs = options.timeoutMs ?? 1000;
  const memoryMb = options.memoryMb ?? 64;

  return new Promise((resolve) => {
    const worker = new Worker(RUNNER, {
      eval: true,
      workerData: { code, globals: options.globals ?? {} },
      resourceLimits: { maxOldGenerationSizeMb: memoryMb },
    });

    let settled = false;
    const finish = (r: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(r);
    };

    const timer = setTimeout(() => finish({ ok: false, error: `Timed out after ${timeoutMs}ms`, logs: [], timedOut: true }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    worker.on('message', (msg: { ok: boolean; value?: unknown; error?: string; logs: string[] }) => {
      finish({ ok: msg.ok, value: msg.value, error: msg.error, logs: msg.logs ?? [], timedOut: false });
    });
    worker.on('error', (err) => finish({ ok: false, error: err.message, logs: [], timedOut: false }));
    worker.on('exit', (code) => {
      if (!settled) finish({ ok: false, error: `Worker exited (code ${code}) — likely out of memory`, logs: [], timedOut: false });
    });
  });
}

/** Worker bootstrap: runs the code in a restricted vm context and reports back. */
const RUNNER = `
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const logs = [];
const sandbox = Object.assign(Object.create(null), {
  console: { log: (...a) => logs.push(a.map(String).join(' ')) },
  ...(workerData.globals || {}),
});
try {
  const value = vm.runInNewContext(workerData.code, sandbox, { timeout: 5000 });
  parentPort.postMessage({ ok: true, value: safe(value), logs });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err), logs });
}
function safe(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}
`;

export const MODULE_STATUS = 'active' as const;

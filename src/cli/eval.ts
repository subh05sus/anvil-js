import path from 'node:path';
import { createJiti } from 'jiti';
import { runSuite, type EvalReport, type EvalSuite } from '../eval/index.js';

export interface EvalCliOptions {
  /** Path to a suite file default-exporting an EvalSuite (from defineEvalSuite). */
  file: string;
}

export async function evalCommand(options: EvalCliOptions): Promise<void> {
  const file = path.resolve(options.file);
  const jiti = createJiti(import.meta.url, { interopDefault: false });
  const mod = (await jiti.import(file)) as { default?: EvalSuite };
  if (!mod.default || !Array.isArray(mod.default.cases)) {
    console.error(`[anvil] ${options.file} must default-export a suite from defineEvalSuite(...)`);
    process.exitCode = 1;
    return;
  }

  const report = await runSuite(mod.default);
  printReport(report);
  if (report.failed > 0) process.exitCode = 1;
}

function printReport(report: EvalReport): void {
  console.log(`\n${report.suite}`);
  for (const c of report.cases) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (c.error) console.log(`        error: ${c.error}`);
    for (const a of c.assertions) {
      if (!a.pass) console.log(`        ✗ ${a.name}${a.message ? ` — ${a.message}` : ''}`);
    }
  }
  console.log(`\n[anvil] eval: ${report.passed} passed, ${report.failed} failed`);
}

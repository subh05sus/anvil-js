import path from 'node:path';
import { createJiti } from 'jiti';
import { validateRoutes } from '../compiler/validate.js';

export interface LintOptions {
  routes: string;
  /** Treat warnings as errors (exit non-zero). */
  strict?: boolean;
}

export async function lintCommand(options: LintOptions): Promise<void> {
  const routesDir = path.resolve(options.routes);
  const jiti = createJiti(import.meta.url, { interopDefault: false });

  const { diagnostics, errorCount, warningCount } = await validateRoutes(routesDir, (file) => jiti.import(file));

  for (const d of diagnostics) {
    const tag = d.level === 'error' ? 'error' : 'warn ';
    const rel = path.relative(process.cwd(), d.file);
    console.error(`  ${tag}  ${d.route.padEnd(24)} ${d.message}\n         ${rel}  [${d.rule}]`);
  }

  if (diagnostics.length === 0) {
    console.log('[anvil] lint: no issues found');
    return;
  }

  console.error(`\n[anvil] lint: ${errorCount} error(s), ${warningCount} warning(s)`);
  if (errorCount > 0 || (options.strict && warningCount > 0)) {
    process.exitCode = 1;
  }
}

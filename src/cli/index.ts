#!/usr/bin/env node
import { Command } from 'commander';
import { buildCommand } from './build.js';
import { devCommand } from './dev.js';
import { startCommand } from './start.js';

const program = new Command();

program.name('anvil').description('Anvil JS — Express for humans. Anvil for agents.').version('0.0.1');

program
  .command('dev')
  .description('Start the dev server with watch mode')
  .option('-r, --routes <dir>', 'routes directory', 'server/routes')
  .option('-p, --port <port>', 'port to listen on', '3000')
  .option('-H, --hostname <host>', 'hostname to bind')
  .action((opts: { routes: string; port: string; hostname?: string }) =>
    devCommand({ routes: opts.routes, port: Number(opts.port), hostname: opts.hostname }),
  );

program
  .command('build')
  .description('Generate the route manifest and bundle the production server')
  .option('-r, --routes <dir>', 'routes directory', 'server/routes')
  .option('-g, --gen-dir <dir>', 'generated sources directory', '.gen')
  .option('-o, --out <file>', 'output bundle', 'dist/server.mjs')
  .option('--manifest-only', 'only emit the manifest, skip bundling')
  .action((opts: { routes: string; genDir: string; out: string; manifestOnly?: boolean }) =>
    buildCommand(opts),
  );

program
  .command('start')
  .description('Run the production bundle')
  .option('-e, --entry <file>', 'bundle entry', 'dist/server.mjs')
  .option('-p, --port <port>', 'port to listen on')
  .action((opts: { entry: string; port?: string }) =>
    startCommand({ entry: opts.entry, port: opts.port ? Number(opts.port) : undefined }),
  );

for (const [name, milestone] of [
  ['mcp', 'M2 (MCP auto-exposure)'],
  ['lint', 'M1 (compile-time validation)'],
  ['eval', 'M6 (agent evals harness)'],
  ['replay', 'M6 (trace replay)'],
] as const) {
  program
    .command(name)
    .description(`Planned — lands in ${milestone}`)
    .action(() => {
      console.error(`[anvil] \`anvil ${name}\` lands in ${milestone}. See PRD.md §10.`);
      process.exitCode = 1;
    });
}

program.parseAsync().catch((err) => {
  console.error('[anvil]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

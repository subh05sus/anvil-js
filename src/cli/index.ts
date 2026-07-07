#!/usr/bin/env node
import { Command } from 'commander';
import { buildCommand } from './build.js';
import { devCommand } from './dev.js';
import { evalCommand } from './eval.js';
import { lintCommand } from './lint.js';
import { mcpCommand } from './mcp.js';
import { replayCommand } from './replay.js';
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

program
  .command('lint')
  .description('Validate routes: param/schema consistency and tool-schema serializability')
  .option('-r, --routes <dir>', 'routes directory', 'server/routes')
  .option('--strict', 'treat warnings as errors')
  .action((opts: { routes: string; strict?: boolean }) => lintCommand(opts));

program
  .command('mcp')
  .description('Serve MCP-exposed routes and server/tools as an MCP server')
  .option('-r, --routes <dir>', 'routes directory', 'server/routes')
  .option('-t, --tools <dir>', 'tools directory', 'server/tools')
  .option('--stdio', 'serve over stdio (for local clients like Claude Desktop)')
  .option('-p, --port <port>', 'HTTP port', '3100')
  .option('-e, --endpoint <path>', 'HTTP endpoint path', '/mcp')
  .action((opts: { routes: string; tools: string; stdio?: boolean; port: string; endpoint: string }) =>
    mcpCommand({
      routes: opts.routes,
      tools: opts.tools,
      stdio: opts.stdio,
      port: Number(opts.port),
      endpoint: opts.endpoint,
    }),
  );

program
  .command('eval')
  .description('Run an eval suite (deterministic + LLM-judge assertions) against an agent')
  .argument('<file>', 'suite file default-exporting defineEvalSuite(...)')
  .action((file: string) => evalCommand({ file }));

program
  .command('replay')
  .description('Re-run a captured agent trace with mocked model responses (no live calls)')
  .argument('<traceId>', 'trace id to replay')
  .option('-s, --store <file>', 'SQLite trace DB file', '.anvil/traces.db')
  .action((traceId: string, opts: { store: string }) => replayCommand({ traceId, store: opts.store }));

program.parseAsync().catch((err) => {
  console.error('[anvil]', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});

#!/usr/bin/env node
import { Command } from 'commander';
import { buildCommand } from './build.js';
import { devCommand } from './dev.js';
import { evalCommand } from './eval.js';
import { initCommand } from './init.js';
import type { TemplateId } from './init-templates.js';
import { lintCommand } from './lint.js';
import { mcpCommand } from './mcp.js';
import { replayCommand } from './replay.js';
import { serveCommand } from './serve.js';
import { startCommand } from './start.js';

const program = new Command();

program.name('anvil').description('Anvil JS — Express for humans. Anvil for agents.').version('1.0.2');

program
  .command('init')
  .description('Scaffold a new Anvil project (package.json, tsconfig, starter routes)')
  .argument('[dir]', 'target directory', '.')
  .option('-t, --template <name>', 'template: basic | mcp | agent (skips the prompt)')
  .option('-y, --yes', 'skip the prompt, defaulting to the basic template')
  .action((dir: string, opts: { template?: TemplateId; yes?: boolean }) =>
    initCommand({ dir, template: opts.template, yes: opts.yes }),
  );

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
  .description('Serve MCP-exposed routes, tools, resources, and prompts as an MCP server')
  .option('-r, --routes <dir>', 'routes directory', 'server/routes')
  .option('-t, --tools <dir>', 'tools directory', 'server/tools')
  .option('--resources <dir>', 'resources directory', 'server/resources')
  .option('--prompts <dir>', 'prompts directory', 'server/prompts')
  .option('--stdio', 'serve over stdio (for local clients like Claude Desktop)')
  .option('--stateful', 'use the stateful HTTP transport (sessions + SSE)')
  .option('-p, --port <port>', 'HTTP port', '3100')
  .option('-e, --endpoint <path>', 'HTTP endpoint path', '/mcp')
  .action(
    (opts: {
      routes: string;
      tools: string;
      resources: string;
      prompts: string;
      stdio?: boolean;
      stateful?: boolean;
      port: string;
      endpoint: string;
    }) =>
      mcpCommand({
        routes: opts.routes,
        tools: opts.tools,
        resources: opts.resources,
        prompts: opts.prompts,
        stdio: opts.stdio,
        stateful: opts.stateful,
        port: Number(opts.port),
        endpoint: opts.endpoint,
      }),
  );

program
  .command('serve')
  .description('Run scheduled + event-triggered background agents with a trigger webhook')
  .option('-d, --dir <dir>', 'background tasks directory', 'server')
  .option('-p, --port <port>', 'trigger webhook port', '3200')
  .option('-e, --endpoint <path>', 'trigger endpoint prefix', '/triggers')
  .option('--interval <ms>', 'scheduler poll interval (ms)', '60000')
  .option('--trace <target>', "trace store: a sqlite path or 'memory'")
  .option('--token <token>', 'bearer token required to fire triggers')
  .action((opts: { dir: string; port: string; endpoint: string; interval: string; trace?: string; token?: string }) =>
    serveCommand({
      dir: opts.dir,
      port: Number(opts.port),
      endpoint: opts.endpoint,
      interval: Number(opts.interval),
      trace: opts.trace,
      token: opts.token,
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

import path from 'node:path';
import { existsSync } from 'node:fs';
import { createJiti } from 'jiti';
import { serve } from '../kernel/adapter-node.js';
import { mcpHttpHandler } from '../mcp/http.js';
import { McpServer } from '../mcp/server.js';
import { serveStdio } from '../mcp/stdio.js';
import { buildServer } from '../mcp/build.js';

export interface McpOptions {
  routes: string;
  tools: string;
  /** Resources directory. Default: server/resources. */
  resources?: string;
  /** Prompts directory. Default: server/prompts. */
  prompts?: string;
  /** Serve over stdio instead of HTTP. */
  stdio?: boolean;
  /** Use the stateful HTTP transport (sessions + SSE). */
  stateful?: boolean;
  port: number;
  endpoint: string;
}

export async function mcpCommand(options: McpOptions): Promise<void> {
  const routesDir = path.resolve(options.routes);
  const toolsDir = path.resolve(options.tools);
  const resourcesDir = options.resources ? path.resolve(options.resources) : path.resolve('server/resources');
  const promptsDir = options.prompts ? path.resolve(options.prompts) : path.resolve('server/prompts');
  const jiti = createJiti(import.meta.url, { interopDefault: false });

  const { tools, resources, resourceTemplates, prompts } = await buildServer({
    routesDir,
    toolsDir: existsSync(toolsDir) ? toolsDir : undefined,
    resourcesDir: existsSync(resourcesDir) ? resourcesDir : undefined,
    promptsDir: existsSync(promptsDir) ? promptsDir : undefined,
    importer: (file) => jiti.import(file),
  });

  const server = new McpServer({ info: { name: 'anvil', version: '1.0.2' }, tools, resources, resourceTemplates, prompts });

  const summary = `${tools.length} tool(s), ${resources.length + resourceTemplates.length} resource(s), ${prompts.length} prompt(s)`;

  if (options.stdio) {
    // stdout is the protocol channel — diagnostics must go to stderr.
    console.error(`[anvil] mcp stdio: ${summary}`);
    await serveStdio(server);
    return;
  }

  const handler = mcpHttpHandler(server, { path: options.endpoint, stateful: options.stateful });
  const running = await serve({ fetch: handler }, { port: options.port });
  const mode = options.stateful ? 'stateful' : 'stateless';
  console.log(`[anvil] mcp (Streamable HTTP, ${mode}) on http://localhost:${running.port}${options.endpoint}`);
  console.log(`[anvil] ${summary}`);
}

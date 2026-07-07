import path from 'node:path';
import { existsSync } from 'node:fs';
import { createJiti } from 'jiti';
import { serve } from '../kernel/adapter-node.js';
import { mcpHttpHandler } from '../mcp/http.js';
import { McpServer } from '../mcp/server.js';
import { serveStdio } from '../mcp/stdio.js';
import { buildToolset } from '../mcp/tool.js';

export interface McpOptions {
  routes: string;
  tools: string;
  /** Serve over stdio instead of HTTP. */
  stdio?: boolean;
  port: number;
  endpoint: string;
}

export async function mcpCommand(options: McpOptions): Promise<void> {
  const routesDir = path.resolve(options.routes);
  const toolsDir = path.resolve(options.tools);
  const jiti = createJiti(import.meta.url, { interopDefault: false });

  const tools = await buildToolset({
    routesDir,
    toolsDir: existsSync(toolsDir) ? toolsDir : undefined,
    importer: (file) => jiti.import(file),
  });

  const server = new McpServer(tools, { name: 'anvil', version: '1.0.0' });

  if (options.stdio) {
    // stdout is the protocol channel — diagnostics must go to stderr.
    console.error(`[anvil] mcp stdio: ${tools.length} tool(s) — ${tools.map((t) => t.name).join(', ') || 'none'}`);
    await serveStdio(server);
    return;
  }

  const handler = mcpHttpHandler(server, { path: options.endpoint });
  const running = await serve({ fetch: handler }, { port: options.port });
  console.log(`[anvil] mcp (Streamable HTTP) on http://localhost:${running.port}${options.endpoint}`);
  console.log(`[anvil] ${tools.length} tool(s): ${tools.map((t) => t.name).join(', ') || 'none'}`);
}

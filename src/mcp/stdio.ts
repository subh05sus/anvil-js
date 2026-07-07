import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { McpServer } from './server.js';
import { RPC, type JsonRpcRequest } from './types.js';

/**
 * Process one line of newline-delimited JSON-RPC. Returns the serialized
 * response line, or null for notifications / blank lines. Exported so the
 * framing is unit-testable without spawning a process.
 */
export async function processLine(server: McpServer, line: string): Promise<string | null> {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let message: JsonRpcRequest;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: RPC.PARSE_ERROR, message: 'Parse error' } });
  }

  const response = await server.handle(message);
  return response ? JSON.stringify(response) : null;
}

export interface StdioOptions {
  input?: Readable;
  output?: Writable;
}

/**
 * Serve MCP over stdio (newline-delimited JSON-RPC) — the transport Claude
 * Desktop and other local clients use. Resolves when the input stream closes.
 */
export function serveStdio(server: McpServer, options: StdioOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, crlfDelay: Infinity });

  return new Promise((resolve) => {
    rl.on('line', (line) => {
      void processLine(server, line).then((out) => {
        if (out !== null) output.write(out + '\n');
      });
    });
    rl.on('close', resolve);
  });
}

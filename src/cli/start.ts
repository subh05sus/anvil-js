import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export interface StartOptions {
  /** Bundle produced by `anvil build`. Default: 'dist/server.mjs'. */
  entry: string;
  port?: number;
}

export async function startCommand(options: StartOptions): Promise<void> {
  const entry = path.resolve(options.entry);
  try {
    await access(entry);
  } catch {
    console.error(`[anvil] ${entry} not found — run \`anvil build\` first`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: options.port ? { ...process.env, PORT: String(options.port) } : process.env,
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}

import path from 'node:path';
import chokidar from 'chokidar';
import { createJiti } from 'jiti';
import { serve } from '../kernel/adapter-node.js';
import { createApp, type App } from '../kernel/app.js';
import { loadManifest } from '../compiler/loader.js';

export interface DevOptions {
  routes: string;
  port: number;
  hostname?: string;
}

export async function devCommand(options: DevOptions): Promise<void> {
  const routesDir = path.resolve(options.routes);

  let app: App = await buildApp(routesDir, true);

  const server = await serve(() => app, { port: options.port, hostname: options.hostname });
  console.log(`[anvil] dev server listening on http://localhost:${server.port}`);

  let reloadTimer: NodeJS.Timeout | undefined;
  chokidar
    .watch(routesDir, { ignoreInitial: true })
    .on('all', () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        try {
          app = await buildApp(routesDir);
          console.log('[anvil] routes reloaded');
        } catch (err) {
          // Keep serving the last good route table; surface the compile error.
          console.error('[anvil] reload failed:', err instanceof Error ? err.message : err);
        }
      }, 100);
    });
}

async function buildApp(routesDir: string, printRoutes = false): Promise<App> {
  // A fresh jiti instance per reload: module cache ON so singletons shared
  // across route files (e.g. a shared trace store) resolve to one instance
  // within a build pass; the new instance per reload re-reads edited files.
  const jiti = createJiti(import.meta.url, { fsCache: false, interopDefault: false });
  const importer = (file: string) => jiti.import(file);
  const manifest = await loadManifest(routesDir, importer);
  if (printRoutes) {
    for (const route of manifest.routes) {
      console.log(`  ${route.method.padEnd(7)} ${route.pattern}`);
    }
  }
  return createApp(manifest, { dev: true });
}

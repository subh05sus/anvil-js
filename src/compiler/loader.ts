import { pathToFileURL } from 'node:url';
import type { Handler, Manifest, Middleware, RouteDefinition, RouteMeta } from '../kernel/types.js';
import type { ScannedRoute } from './scanner.js';
import { scanRoutes } from './scanner.js';

export type Importer = (file: string) => Promise<unknown>;

const defaultImporter: Importer = (file) => import(pathToFileURL(file).href);

interface RouteModule {
  default?: unknown;
  meta?: RouteMeta;
}

interface MiddlewareModule {
  default?: unknown;
}

/**
 * Runtime manifest loading: scan the routes directory and import every
 * handler/middleware module. Used by `anvil dev` (with a jiti importer for
 * TypeScript) — production uses the codegen manifest instead.
 */
export async function loadManifest(routesDir: string, importer: Importer = defaultImporter): Promise<Manifest> {
  const { routes, rootMiddlewareFile } = await scanRoutes(routesDir);

  const middlewareCache = new Map<string, Middleware[]>();
  const definitions: RouteDefinition[] = [];

  for (const route of routes) {
    const mod = (await importer(route.file)) as RouteModule;
    if (typeof mod.default !== 'function') {
      throw new TypeError(`Route file ${route.file} must default-export a handler function`);
    }

    const middleware: Middleware[] = [];
    for (const file of route.middlewareFiles) {
      let stack = middlewareCache.get(file);
      if (!stack) {
        stack = await loadMiddleware(file, importer);
        middlewareCache.set(file, stack);
      }
      middleware.push(...stack);
    }

    definitions.push({
      method: route.method,
      pattern: route.pattern,
      segments: route.segments,
      handler: mod.default as Handler,
      middleware,
      meta: mod.meta,
      file: route.file,
    });
  }

  let fallbackMiddleware: Middleware[] | undefined;
  if (rootMiddlewareFile) {
    fallbackMiddleware =
      middlewareCache.get(rootMiddlewareFile) ?? (await loadMiddleware(rootMiddlewareFile, importer));
  }

  return { routes: definitions, fallbackMiddleware };
}

async function loadMiddleware(file: string, importer: Importer): Promise<Middleware[]> {
  const mod = (await importer(file)) as MiddlewareModule;
  const exported = mod.default;
  const stack = Array.isArray(exported) ? exported : [exported];
  for (const fn of stack) {
    if (typeof fn !== 'function') {
      throw new TypeError(
        `Middleware file ${file} must default-export a middleware function or an array of them`,
      );
    }
  }
  return stack as Middleware[];
}

export type { ScannedRoute };

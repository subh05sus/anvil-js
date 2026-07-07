import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { RouteConflictError } from '../kernel/errors.js';
import type { HttpMethod, Segment } from '../kernel/types.js';

const METHOD_FILES: Record<string, HttpMethod> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  head: 'HEAD',
  options: 'OPTIONS',
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const VALID_PARAM_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface ScannedRoute {
  method: HttpMethod;
  /** Route pattern, e.g. `/users/[id]`. Groups are stripped. */
  pattern: string;
  segments: Segment[];
  /** Absolute path of the method file. */
  file: string;
  /** Absolute paths of `_middleware` files, root → leaf. */
  middlewareFiles: string[];
}

export interface ScanResult {
  routes: ScannedRoute[];
  /** Root-level `_middleware` file, if present — also runs for unmatched paths. */
  rootMiddlewareFile?: string;
}

/**
 * Walk `routesDir` and produce the route table, enforcing the M0 subset of
 * the PRD §5.6 validations:
 *  - case-insensitive route collisions (Windows/Linux filesystem divergence)
 *  - conflicting dynamic segment names at the same position ([id] vs [slug])
 *  - duplicate param names within one route path
 *  - catch-all directories must be leaves
 */
export async function scanRoutes(routesDir: string): Promise<ScanResult> {
  const root = path.resolve(routesDir);
  const routes: ScannedRoute[] = [];
  await walk(root, [], [], routes);
  validate(routes);
  // Deterministic manifest output regardless of filesystem enumeration order.
  routes.sort((a, b) => (a.pattern === b.pattern ? a.method.localeCompare(b.method) : a.pattern.localeCompare(b.pattern)));

  const rootEntries = await readdir(root, { withFileTypes: true });
  const rootMiddleware = rootEntries.find(
    (e) => e.isFile() && isSourceFile(e.name) && baseName(e.name) === '_middleware',
  );
  return { routes, rootMiddlewareFile: rootMiddleware ? path.join(root, rootMiddleware.name) : undefined };
}

async function walk(
  dir: string,
  segments: Segment[],
  middlewareFiles: string[],
  routes: ScannedRoute[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  const middlewareHere = entries.find(
    (e) => e.isFile() && isSourceFile(e.name) && baseName(e.name) === '_middleware',
  );
  const middleware = middlewareHere
    ? [...middlewareFiles, path.join(dir, middlewareHere.name)]
    : middlewareFiles;

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isFile()) {
      if (!isSourceFile(entry.name)) continue;
      const base = baseName(entry.name);
      if (base.startsWith('_')) continue; // _middleware, _context, other conventions
      const method = METHOD_FILES[base];
      if (!method) continue; // agent.ts / schedule.ts etc. land in later milestones
      routes.push({
        method,
        pattern: patternOf(segments),
        segments,
        file: full,
        middlewareFiles: middleware,
      });
      continue;
    }

    if (!entry.isDirectory()) continue;

    const segment = parseDirName(entry.name, full);
    if (segment === null) {
      // Route group — contributes no URL segment.
      await walk(full, segments, middleware, routes);
      continue;
    }

    if (segment.type === 'catchall') {
      const children = await readdir(full, { withFileTypes: true });
      const subdir = children.find((c) => c.isDirectory());
      if (subdir) {
        throw new RouteConflictError(
          `Catch-all directory "${entry.name}" cannot contain subdirectories (found "${subdir.name}" in ${full})`,
        );
      }
    }

    if (segment.type !== 'static') {
      const duplicate = segments.find(
        (s) => s.type !== 'static' && s.name === segment.name,
      );
      if (duplicate) {
        throw new RouteConflictError(
          `Duplicate dynamic parameter "${segment.name}" in route path at ${full}`,
        );
      }
    }

    await walk(full, [...segments, segment], middleware, routes);
  }
}

/** Returns null for route groups `(name)`. */
function parseDirName(name: string, fullPath: string): Segment | null {
  if (name.startsWith('(') && name.endsWith(')')) return null;
  if (name.startsWith('[...') && name.endsWith(']')) {
    const param = name.slice(4, -1);
    assertParamName(param, fullPath);
    return { type: 'catchall', name: param };
  }
  if (name.startsWith('[') && name.endsWith(']')) {
    const param = name.slice(1, -1);
    assertParamName(param, fullPath);
    return { type: 'param', name: param };
  }
  return { type: 'static', value: name };
}

function assertParamName(name: string, fullPath: string): void {
  if (!VALID_PARAM_NAME.test(name)) {
    throw new RouteConflictError(`Invalid dynamic segment name "${name}" at ${fullPath}`);
  }
}

function validate(routes: ScannedRoute[]): void {
  // 1. Case-insensitive duplicate detection (method + normalized path).
  const byKey = new Map<string, ScannedRoute>();
  // 2. Canonical casing per static position; 3. one dynamic name per position.
  const staticCasing = new Map<string, { value: string; file: string }>();
  const dynamicNames = new Map<string, { name: string; type: string; file: string }>();

  for (const route of routes) {
    // Positional checks run first so [id]-vs-[slug] style conflicts get their
    // specific error instead of the generic duplicate-route one.
    let prefix = '';
    for (const segment of route.segments) {
      const position = `${prefix}/${normalizeSegment(segment)}`;
      if (segment.type === 'static') {
        const seen = staticCasing.get(position);
        if (!seen) {
          staticCasing.set(position, { value: segment.value, file: route.file });
        } else if (seen.value !== segment.value) {
          throw new RouteConflictError(
            `Case-insensitive collision: path segment "${segment.value}" (${route.file}) vs ` +
              `"${seen.value}" (${seen.file}). Windows treats these as the same directory; Linux does not.`,
          );
        }
      } else {
        const seen = dynamicNames.get(position);
        if (!seen) {
          dynamicNames.set(position, { name: segment.name, type: segment.type, file: route.file });
        } else if (seen.name !== segment.name) {
          throw new RouteConflictError(
            `Conflicting dynamic segments at the same position: [${segment.type === 'catchall' ? '...' : ''}${segment.name}] ` +
              `(${route.file}) vs [${seen.type === 'catchall' ? '...' : ''}${seen.name}] (${seen.file})`,
          );
        }
      }
      prefix = position;
    }

    const key = `${route.method} ${prefix || '/'}`;
    const existing = byKey.get(key);
    if (existing) {
      throw new RouteConflictError(
        `Route conflict: ${route.method} ${route.pattern} (${route.file}) collides with ` +
          `${existing.method} ${existing.pattern} (${existing.file}). ` +
          `Routes must be unique case-insensitively — case-only differences break between Windows and Linux filesystems.`,
      );
    }
    byKey.set(key, route);
  }
}

function normalizeSegment(segment: Segment): string {
  switch (segment.type) {
    case 'static':
      return segment.value.toLowerCase();
    case 'param':
      return ':p';
    case 'catchall':
      return ':c';
  }
}

function patternOf(segments: Segment[]): string {
  if (segments.length === 0) return '/';
  return (
    '/' +
    segments
      .map((s) => (s.type === 'static' ? s.value : s.type === 'param' ? `[${s.name}]` : `[...${s.name}]`))
      .join('/')
  );
}

function isSourceFile(name: string): boolean {
  if (name.endsWith('.d.ts') || name.endsWith('.d.mts')) return false;
  return SOURCE_EXTENSIONS.has(path.extname(name));
}

function baseName(name: string): string {
  return name.slice(0, name.length - path.extname(name).length);
}

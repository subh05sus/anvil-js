import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import type { Segment } from '../kernel/types.js';
import { tryZodToJsonSchema } from './json-schema.js';
import type { ScannedRoute } from './scanner.js';
import { scanRoutes } from './scanner.js';

export type DiagnosticLevel = 'error' | 'warning';

export interface Diagnostic {
  level: DiagnosticLevel;
  /** e.g. "GET /users/[id]". */
  route: string;
  file: string;
  message: string;
  /** Machine-readable check id, for filtering/suppression later. */
  rule: string;
}

export interface ValidateResult {
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
}

export type Importer = (file: string) => Promise<unknown>;

const defaultImporter: Importer = (file) => import(pathToFileURL(file).href);

/** Schema export names that must round-trip to JSON Schema when a route is MCP/A2A exposed. */
const EXPOSABLE_SCHEMAS = ['paramsSchema', 'querySchema', 'bodySchema', 'outputSchema'] as const;

interface RouteModule {
  default?: unknown;
  meta?: { mcp?: { expose?: boolean; description?: unknown } };
  paramsSchema?: unknown;
  querySchema?: unknown;
  bodySchema?: unknown;
  outputSchema?: unknown;
}

/**
 * M1 compile-time validation. Scans the routes directory, loads each handler
 * module, and reports diagnostics without throwing. Structural conflicts
 * (duplicate/ambiguous routes, case collisions) are already enforced by the
 * scanner and surface here as a single error rather than aborting the pass.
 */
export async function validateRoutes(routesDir: string, importer: Importer = defaultImporter): Promise<ValidateResult> {
  const diagnostics: Diagnostic[] = [];

  let routes: ScannedRoute[];
  try {
    ({ routes } = await scanRoutes(routesDir));
  } catch (err) {
    diagnostics.push({
      level: 'error',
      route: '(scan)',
      file: routesDir,
      message: err instanceof Error ? err.message : String(err),
      rule: 'route-structure',
    });
    return summarize(diagnostics);
  }

  for (const route of routes) {
    const label = `${route.method} ${route.pattern}`;
    const add = (level: DiagnosticLevel, rule: string, message: string) =>
      diagnostics.push({ level, route: label, file: route.file, message, rule });

    let mod: RouteModule;
    try {
      mod = (await importer(route.file)) as RouteModule;
    } catch (err) {
      add('error', 'import-failed', `Failed to import route module: ${err instanceof Error ? err.message : err}`);
      continue;
    }

    if (typeof mod.default !== 'function') {
      add('error', 'missing-handler', 'Route file must default-export a handler function.');
    }

    validateParams(route, mod.paramsSchema, add);
    validateExposure(mod, add);
  }

  return summarize(diagnostics);
}

function validateParams(
  route: ScannedRoute,
  paramsSchema: unknown,
  add: (level: DiagnosticLevel, rule: string, message: string) => void,
): void {
  const folderParams = route.segments
    .filter((s): s is Extract<Segment, { name: string }> => s.type !== 'static')
    .map((s) => s.name);

  if (paramsSchema === undefined) return; // No schema → nothing to cross-check at M1.

  const shape = objectShape(paramsSchema);
  if (!shape) {
    add('error', 'params-schema-shape', 'paramsSchema must be a z.object({...}) so its keys can match the route params.');
    return;
  }

  const schemaKeys = Object.keys(shape);
  const missing = folderParams.filter((p) => !schemaKeys.includes(p));
  const extra = schemaKeys.filter((k) => !folderParams.includes(k));

  if (missing.length > 0) {
    add(
      'error',
      'params-missing',
      `paramsSchema is missing route parameter(s): ${missing.map((p) => `"${p}"`).join(', ')}. ` +
        `The folder declares [${folderParams.join('], [')}].`,
    );
  }
  if (extra.length > 0) {
    add(
      'error',
      'params-extra',
      `paramsSchema declares key(s) with no matching route segment: ${extra.map((k) => `"${k}"`).join(', ')}. ` +
        `Rename the folder or remove the key.`,
    );
  }
}

function validateExposure(
  mod: RouteModule,
  add: (level: DiagnosticLevel, rule: string, message: string) => void,
): void {
  if (mod.meta?.mcp?.expose !== true) return;

  const description = mod.meta.mcp.description;
  if (typeof description !== 'string' || description.trim() === '') {
    add(
      'warning',
      'mcp-missing-description',
      'MCP-exposed route has no meta.mcp.description. Tools without descriptions are hard for agents to use.',
    );
  }

  for (const name of EXPOSABLE_SCHEMAS) {
    const schema = mod[name];
    if (schema === undefined) continue;
    const result = tryZodToJsonSchema(schema as z.ZodTypeAny);
    if (!result.ok) {
      add('error', 'mcp-schema-not-serializable', `${name}: ${result.error.message}`);
    }
  }
}

/** Return a ZodObject's shape record, or null if the value is not a ZodObject. */
function objectShape(schema: unknown): Record<string, unknown> | null {
  const def = (schema as { _def?: { typeName?: string; shape?: () => Record<string, unknown> } })._def;
  if (!def || def.typeName !== 'ZodObject' || typeof def.shape !== 'function') return null;
  return def.shape();
}

function summarize(diagnostics: Diagnostic[]): ValidateResult {
  let errorCount = 0;
  let warningCount = 0;
  for (const d of diagnostics) {
    if (d.level === 'error') errorCount++;
    else warningCount++;
  }
  return { diagnostics, errorCount, warningCount };
}

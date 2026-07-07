import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from '../compiler/json-schema.js';
import { scanRoutes, type ScannedRoute } from '../compiler/scanner.js';
import { Context, toResponse } from '../kernel/context.js';
import type { Handler, Segment } from '../kernel/types.js';
import type { ToolDefinition } from './types.js';

export type Importer = (file: string) => Promise<unknown>;

const defaultImporter: Importer = (file) => import(pathToFileURL(file).href);

const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.js', '.mjs']);
const MCP_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

interface RouteModule {
  default?: unknown;
  meta?: { mcp?: { expose?: boolean; name?: unknown; description?: unknown } };
  paramsSchema?: unknown;
  bodySchema?: unknown;
}

interface ToolModule {
  default?: unknown;
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  meta?: { description?: unknown };
}

export interface ToolsetOptions {
  routesDir: string;
  /** Optional standalone tools directory (default convention: server/tools). */
  toolsDir?: string;
  importer?: Importer;
}

/**
 * Assemble the full toolset from both sources. Names must be globally unique
 * (MCP tools are addressed by name), so collisions are a hard error.
 */
export async function buildToolset(options: ToolsetOptions): Promise<ToolDefinition[]> {
  const importer = options.importer ?? defaultImporter;
  const tools: ToolDefinition[] = [];

  const { routes } = await scanRoutes(options.routesDir);
  for (const route of routes) {
    const mod = (await importer(route.file)) as RouteModule;
    if (mod.meta?.mcp?.expose === true) tools.push(routeToTool(route, mod, importer));
  }

  if (options.toolsDir && (await isDir(options.toolsDir))) {
    for (const file of await walkFiles(options.toolsDir)) {
      const mod = (await importer(file)) as ToolModule;
      tools.push(registryTool(file, mod));
    }
  }

  assertUniqueNames(tools);
  return tools;
}

/** Convert a `meta.mcp.expose` route into a tool. */
export function routeToTool(route: ScannedRoute, mod: RouteModule, _importer: Importer = defaultImporter): ToolDefinition {
  const name = toolName(route, mod);
  const description = typeof mod.meta?.mcp?.description === 'string' ? mod.meta.mcp.description : '';
  const zodSchema = mergeInputSchema(mod.paramsSchema, mod.bodySchema);
  const folderParams = route.segments
    .filter((s): s is Extract<Segment, { name: string }> => s.type !== 'static')
    .map((s) => s.name);
  const handler = mod.default as Handler;

  return {
    name,
    description,
    inputSchema: zodToJsonSchema(zodSchema),
    zodSchema,
    source: 'route',
    file: route.file,
    invoke: async (args) => {
      const record = (args ?? {}) as Record<string, unknown>;
      const params: Record<string, string> = {};
      for (const p of folderParams) {
        if (record[p] !== undefined) params[p] = String(record[p]);
      }
      const hasBody = route.method !== 'GET' && route.method !== 'HEAD';
      const req = new Request('http://mcp.local/', {
        method: route.method,
        ...(hasBody
          ? { body: JSON.stringify(record), headers: { 'content-type': 'application/json' } }
          : {}),
      });
      // Tools invoke the handler directly — middleware/guardrails wrap the tool
      // surface starting in M5, not here.
      const ctx = new Context(req, params);
      return unwrap(await handler(ctx));
    },
  };
}

function registryTool(file: string, mod: ToolModule): ToolDefinition {
  if (typeof mod.default !== 'function') {
    throw new TypeError(`Tool file ${file} must default-export a function`);
  }
  const fallbackName = path.basename(file, path.extname(file));
  const name = typeof mod.name === 'string' ? mod.name : fallbackName;
  if (!MCP_NAME.test(name)) {
    throw new Error(`Invalid tool name "${name}" (${file}). Names must match ${MCP_NAME}.`);
  }
  const description =
    (typeof mod.description === 'string' && mod.description) ||
    (typeof mod.meta?.description === 'string' && mod.meta.description) ||
    '';
  const zodSchema = isZodObject(mod.inputSchema) ? (mod.inputSchema as z.ZodTypeAny) : z.object({});
  const fn = mod.default as (args: unknown) => unknown;

  return {
    name,
    description,
    inputSchema: zodToJsonSchema(zodSchema),
    zodSchema,
    source: 'registry',
    file,
    invoke: async (args) => fn(args),
  };
}

/** Derive an MCP-legal tool name from a route: `meta.mcp.name`, else `get_users_by_id`. */
function toolName(route: ScannedRoute, mod: RouteModule): string {
  if (typeof mod.meta?.mcp?.name === 'string') {
    if (!MCP_NAME.test(mod.meta.mcp.name)) {
      throw new Error(`Invalid mcp.name "${mod.meta.mcp.name}" in ${route.file}. Must match ${MCP_NAME}.`);
    }
    return mod.meta.mcp.name;
  }
  const parts = route.segments.map((s) =>
    s.type === 'static' ? sanitize(s.value) : `by_${sanitize(s.name)}`,
  );
  const suffix = parts.length > 0 ? parts.join('_') : 'root';
  return `${route.method.toLowerCase()}_${suffix}`;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';
}

function mergeInputSchema(paramsSchema: unknown, bodySchema: unknown): z.ZodTypeAny {
  const parts = [paramsSchema, bodySchema].filter(isZodObject) as z.ZodObject<z.ZodRawShape>[];
  if (parts.length === 0) return z.object({});
  return parts.reduce((acc, s) => acc.merge(s));
}

function isZodObject(schema: unknown): boolean {
  return (schema as { _def?: { typeName?: string } })?._def?.typeName === 'ZodObject';
}

/** Read a handler result into plain data — parse Responses, pass values through. */
async function unwrap(result: unknown): Promise<unknown> {
  if (!(result instanceof Response)) {
    // Non-Response returns (plain object/string) — normalize identically to the kernel, then read back.
    if (result === null || result === undefined) return null;
    if (typeof result === 'object' || typeof result === 'string') return result;
  }
  const res = toResponse(result);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return res.json();
  if (res.status === 204) return null;
  return res.text();
}

function assertUniqueNames(tools: ToolDefinition[]): void {
  const seen = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    const prev = seen.get(tool.name);
    if (prev) {
      throw new Error(
        `Duplicate MCP tool name "${tool.name}": ${prev.file ?? prev.source} and ${tool.file ?? tool.source}. ` +
          `Set a distinct meta.mcp.name.`,
      );
    }
    seen.set(tool.name, tool);
  }
}

async function isDir(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full)));
    } else if (entry.isFile() && !entry.name.startsWith('_') && isSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isSource(name: string): boolean {
  if (name.endsWith('.d.ts')) return false;
  return SOURCE_EXTENSIONS.has(path.extname(name));
}

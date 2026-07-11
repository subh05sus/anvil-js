import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultImporter, isDir, walkFiles, type Importer } from './tool.js';
import type { ResourceContents, ResourceDefinition, ResourceTemplateDefinition } from './types.js';

interface ResourceModule {
  default?: unknown;
  uri?: unknown;
  uriTemplate?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  mimeType?: unknown;
  read?: unknown;
}

export interface DiscoveredResources {
  resources: ResourceDefinition[];
  resourceTemplates: ResourceTemplateDefinition[];
}

/**
 * Discover resources under a directory. Each file default-exports (or names via
 * exports) a resource: a `uri` makes it static, a `uriTemplate` makes it a
 * template. `read` is the accessor.
 */
export async function discoverResources(dir: string, importer: Importer = defaultImporter): Promise<DiscoveredResources> {
  const resources: ResourceDefinition[] = [];
  const resourceTemplates: ResourceTemplateDefinition[] = [];
  if (!(await isDir(dir))) return { resources, resourceTemplates };

  for (const file of await walkFiles(dir)) {
    const mod = (await importer(file)) as ResourceModule;
    const def = (typeof mod.default === 'object' && mod.default ? mod.default : mod) as ResourceModule;
    const read = def.read;
    if (typeof read !== 'function') continue;

    if (typeof def.uriTemplate === 'string') {
      resourceTemplates.push({
        uriTemplate: def.uriTemplate,
        name: typeof def.name === 'string' ? def.name : def.uriTemplate,
        title: typeof def.title === 'string' ? def.title : undefined,
        description: typeof def.description === 'string' ? def.description : undefined,
        mimeType: typeof def.mimeType === 'string' ? def.mimeType : undefined,
        file,
        read: read as ResourceTemplateDefinition['read'],
      });
    } else if (typeof def.uri === 'string') {
      resources.push({
        uri: def.uri,
        name: typeof def.name === 'string' ? def.name : def.uri,
        title: typeof def.title === 'string' ? def.title : undefined,
        description: typeof def.description === 'string' ? def.description : undefined,
        mimeType: typeof def.mimeType === 'string' ? def.mimeType : undefined,
        file,
        read: read as ResourceDefinition['read'],
      });
    }
  }

  assertUniqueUris(resources);
  return { resources, resourceTemplates };
}

function assertUniqueUris(resources: ResourceDefinition[]): void {
  const seen = new Set<string>();
  for (const r of resources) {
    if (seen.has(r.uri)) {
      throw new Error(`Duplicate MCP resource uri "${r.uri}" (${r.file ?? '<inline>'}).`);
    }
    seen.add(r.uri);
  }
}

/**
 * Build a read function that serves a file from `root`, guarding against path
 * traversal. `rel` may come from a resource-template variable — it is decoded
 * and contained within `root` before any read.
 */
export function fileResource(root: string, rel: string, mimeType?: string): () => Promise<ResourceContents> {
  return async () => {
    const decoded = decodeURIComponent(rel);
    const resolvedRoot = path.resolve(root);
    const abs = path.resolve(resolvedRoot, decoded);
    if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
      throw new Error(`Resource path escapes root: ${rel}`);
    }
    const text = await readFile(abs, 'utf8');
    return { text, ...(mimeType ? { mimeType } : {}) };
  };
}

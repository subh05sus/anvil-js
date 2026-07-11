import type { PromptRegistry } from '../prompt/index.js';
import { discoverPrompts, promptsFromRegistry } from './prompts.js';
import { discoverResources } from './resources.js';
import { buildToolset, type ToolsetOptions } from './tool.js';
import type {
  PromptDefinition,
  ResourceDefinition,
  ResourceTemplateDefinition,
  ToolDefinition,
} from './types.js';

export interface ServerBuildOptions extends ToolsetOptions {
  /** Directory of resource definitions. Default convention: server/resources. */
  resourcesDir?: string;
  /** Directory of prompt definitions. Default convention: server/prompts. */
  promptsDir?: string;
  /** Expose a versioned PromptRegistry's prompts over MCP (merged with promptsDir). */
  promptRegistry?: PromptRegistry;
}

export interface BuiltServer {
  tools: ToolDefinition[];
  resources: ResourceDefinition[];
  resourceTemplates: ResourceTemplateDefinition[];
  prompts: PromptDefinition[];
}

/**
 * Assemble the full MCP surface — tools (routes + server/tools), resources, and
 * prompts — from directory conventions and an optional PromptRegistry. Tools
 * reuse the existing `buildToolset`.
 */
export async function buildServer(options: ServerBuildOptions): Promise<BuiltServer> {
  const tools = await buildToolset(options);

  const { resources, resourceTemplates } = options.resourcesDir
    ? await discoverResources(options.resourcesDir, options.importer)
    : { resources: [], resourceTemplates: [] };

  const prompts: PromptDefinition[] = [];
  if (options.promptsDir) prompts.push(...(await discoverPrompts(options.promptsDir, options.importer)));
  if (options.promptRegistry) prompts.push(...(await promptsFromRegistry(options.promptRegistry)));

  return { tools, resources, resourceTemplates, prompts };
}

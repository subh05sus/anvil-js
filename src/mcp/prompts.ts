import { PromptRegistry, renderPrompt } from '../prompt/index.js';
import { defaultImporter, isDir, walkFiles, type Importer } from './tool.js';
import type { PromptArgument, PromptDefinition } from './types.js';

interface PromptModule {
  default?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  arguments?: unknown;
  get?: unknown;
  template?: unknown;
}

/** Extract `{{var}}` placeholder names from a template (same regex renderPrompt uses). */
export function templateArguments(template: string): PromptArgument[] {
  const names = new Set<string>();
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) names.add(m[1]!);
  return [...names].map((name) => ({ name, required: false }));
}

/**
 * Discover prompts under a directory. A file may default-export a
 * `PromptDefinition`, or export a `template` string (rendered with `{{var}}`
 * placeholders) plus optional name/description.
 */
export async function discoverPrompts(dir: string, importer: Importer = defaultImporter): Promise<PromptDefinition[]> {
  const prompts: PromptDefinition[] = [];
  if (!(await isDir(dir))) return prompts;

  for (const file of await walkFiles(dir)) {
    const mod = (await importer(file)) as PromptModule;
    const def = (typeof mod.default === 'object' && mod.default ? mod.default : mod) as PromptModule;

    if (typeof def.get === 'function' && typeof def.name === 'string') {
      prompts.push(def as unknown as PromptDefinition);
      continue;
    }
    if (typeof def.template === 'string') {
      const template = def.template;
      const name = typeof def.name === 'string' ? def.name : fileName(file);
      prompts.push({
        name,
        title: typeof def.title === 'string' ? def.title : undefined,
        description: typeof def.description === 'string' ? def.description : undefined,
        arguments: templateArguments(template),
        file,
        get: (args) => ({ messages: [{ role: 'user', content: { type: 'text', text: renderPrompt(template, args) } }] }),
      });
    }
  }
  return prompts;
}

/**
 * Bridge a versioned PromptRegistry into MCP prompts. Each registered prompt's
 * latest version is exposed; `{{var}}` placeholders become prompt arguments and
 * are filled by `prompts/get`. Reuses the existing registry — no duplication.
 */
export async function promptsFromRegistry(registry: PromptRegistry): Promise<PromptDefinition[]> {
  const names = await registry.names();
  const prompts: PromptDefinition[] = [];
  for (const name of names) {
    const latest = await registry.get(name);
    if (!latest) continue;
    prompts.push({
      name,
      description: latest.note,
      arguments: templateArguments(latest.template),
      get: async (args) => {
        const version = typeof args.version === 'number' ? args.version : undefined;
        const chosen = (await registry.get(name, version)) ?? latest;
        return { messages: [{ role: 'user', content: { type: 'text', text: renderPrompt(chosen.template, args) } }] };
      },
    });
  }
  return prompts;
}

function fileName(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return base.replace(/\.[^.]+$/, '');
}

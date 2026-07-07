import type { StateStore } from '../store/index.js';

export interface PromptVersion {
  version: number;
  template: string;
  note?: string;
  createdAt: number;
}

interface PromptRecord {
  name: string;
  versions: PromptVersion[];
}

export interface PromptDiff {
  from: number;
  to: number;
  added: string[];
  removed: string[];
}

const PREFIX = 'anvil:prompt:';

/**
 * Versioned prompt store (PRD §6.13). Prompts are first-class, immutable
 * versioned artifacts — pin a route to a specific version, diff between
 * versions, and roll a prompt change forward/back independent of code deploys.
 */
export class PromptRegistry {
  #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  /** Append a new immutable version; returns it. Version numbers start at 1. */
  async register(name: string, template: string, note?: string): Promise<PromptVersion> {
    const record = (await this.#store.get<PromptRecord>(PREFIX + name)) ?? { name, versions: [] };
    const version: PromptVersion = {
      version: (record.versions.at(-1)?.version ?? 0) + 1,
      template,
      note,
      createdAt: Date.now(),
    };
    record.versions.push(version);
    await this.#store.set(PREFIX + name, record);
    return version;
  }

  /** Get a specific version, or the latest when `version` is omitted. */
  async get(name: string, version?: number): Promise<PromptVersion | undefined> {
    const record = await this.#store.get<PromptRecord>(PREFIX + name);
    if (!record) return undefined;
    return version === undefined ? record.versions.at(-1) : record.versions.find((v) => v.version === version);
  }

  async list(name: string): Promise<PromptVersion[]> {
    return (await this.#store.get<PromptRecord>(PREFIX + name))?.versions ?? [];
  }

  async names(): Promise<string[]> {
    const keys = await this.#store.list(PREFIX);
    return keys.map((k) => k.slice(PREFIX.length));
  }

  /** Line-level diff between two versions (added/removed lines). */
  async diff(name: string, from: number, to: number): Promise<PromptDiff> {
    const a = await this.get(name, from);
    const b = await this.get(name, to);
    if (!a || !b) throw new Error(`Prompt "${name}" is missing version ${!a ? from : to}`);
    const aLines = a.template.split('\n');
    const bLines = b.template.split('\n');
    const aSet = countLines(aLines);
    const bSet = countLines(bLines);
    return {
      from,
      to,
      added: bLines.filter((l) => decrement(aSet, l) === false),
      removed: aLines.filter((l) => decrement(bSet, l) === false),
    };
  }
}

/** Render `{{var}}` placeholders. Missing vars become empty strings. */
export function renderPrompt(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function countLines(lines: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
}

/** Consume one occurrence of `line` from the multiset; return whether it was present. */
function decrement(set: Map<string, number>, line: string): boolean {
  const n = set.get(line);
  if (!n) return false;
  set.set(line, n - 1);
  return true;
}

export const MODULE_STATUS = 'active' as const;

/** Raised when a guardrail blocks text (input or output). Surfaces as a run error. */
export class GuardrailError extends Error {
  readonly guardrail: string;
  constructor(guardrail: string, message: string) {
    super(message);
    this.name = 'GuardrailError';
    this.guardrail = guardrail;
  }
}

export type ToolDecision = { action: 'allow' | 'deny' | 'approve'; reason?: string };

export interface TextContext {
  role: 'input' | 'output';
}

export interface ToolCallContext {
  name: string;
  input: unknown;
  /** True when untrusted (tool/retrieved) content has already entered the conversation. */
  tainted: boolean;
}

/**
 * Declarative policy for agent routes (PRD §6.14). `onText` filters/redacts
 * user input and model output; `onToolCall` gates tool execution. Applied
 * centrally by the agent runtime, not per handler.
 */
export interface Guardrail {
  name: string;
  /** Transform text (return new text) or throw GuardrailError to block. */
  onText?(text: string, ctx: TextContext): string | void;
  /** Decide whether a tool may run: allow / deny / approve (routes through HITL). */
  onToolCall?(ctx: ToolCallContext): ToolDecision | void;
}

// ── Built-in guardrails ─────────────────────────────────────────────

export interface ContentFilterOptions {
  /** Patterns that are not allowed. */
  deny: RegExp[];
  /** 'block' throws; 'redact' replaces matches with `replacement`. Default 'block'. */
  mode?: 'block' | 'redact';
  replacement?: string;
  /** Which text to inspect. Default both. */
  applyTo?: Array<'input' | 'output'>;
}

/** Block or redact text matching deny patterns. */
export function contentFilter(options: ContentFilterOptions): Guardrail {
  const mode = options.mode ?? 'block';
  const applyTo = options.applyTo ?? ['input', 'output'];
  return {
    name: 'content-filter',
    onText(text, ctx) {
      if (!applyTo.includes(ctx.role)) return;
      for (const re of options.deny) {
        if (re.test(text)) {
          if (mode === 'block') throw new GuardrailError('content-filter', `Blocked ${ctx.role} matching ${re}`);
          text = text.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), options.replacement ?? '[REDACTED]');
        }
      }
      return text;
    },
  };
}

const PII_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, label: '[REDACTED_EMAIL]' },
  { re: /\b(?:\d[ -]?){13,16}\b/g, label: '[REDACTED_CARD]' },
  { re: /\b\d{3}-\d{2}-\d{4}\b/g, label: '[REDACTED_SSN]' },
  { re: /\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, label: '[REDACTED_PHONE]' },
];

/** Redact common PII (email, card, SSN, phone) from input and/or output. */
export function redactPII(options: { applyTo?: Array<'input' | 'output'> } = {}): Guardrail {
  const applyTo = options.applyTo ?? ['input', 'output'];
  return {
    name: 'redact-pii',
    onText(text, ctx) {
      if (!applyTo.includes(ctx.role)) return;
      let out = text;
      for (const { re, label } of PII_PATTERNS) out = out.replace(re, label);
      return out;
    },
  };
}

export interface ToolPolicyOptions {
  /** If set, only these tools may run (others denied). */
  allow?: string[];
  /** These tools are always denied. */
  deny?: string[];
  /** These tools require human approval before running. */
  requireApproval?: string[];
}

/** Per-tool permission scoping (e.g. read orders, but refunds need approval). */
export function toolPolicy(options: ToolPolicyOptions): Guardrail {
  return {
    name: 'tool-policy',
    onToolCall({ name }) {
      if (options.deny?.includes(name)) return { action: 'deny', reason: `tool "${name}" is denied by policy` };
      if (options.allow && !options.allow.includes(name)) return { action: 'deny', reason: `tool "${name}" not in allowlist` };
      if (options.requireApproval?.includes(name)) return { action: 'approve', reason: `tool "${name}" requires approval` };
      return { action: 'allow' };
    },
  };
}

export interface InjectionGuardOptions {
  /** What to do with a tool call made once tainted content is in context. Default 'approve'. */
  mode?: 'block' | 'approve' | 'allow';
  /** Tools always permitted even in tainted context (e.g. read-only lookups). */
  allowlist?: string[];
}

/**
 * Prompt-injection defense (PRD §6.21). Once untrusted tool/retrieved content
 * has entered the conversation, a tool call the model then makes may be
 * injection-driven — gate it (block, or require approval) unless allowlisted.
 * Polices provenance, complementing content-based guardrails.
 */
export function injectionGuard(options: InjectionGuardOptions = {}): Guardrail {
  const mode = options.mode ?? 'approve';
  const allow = new Set(options.allowlist ?? []);
  return {
    name: 'injection-guard',
    onToolCall({ name, tainted }) {
      if (!tainted || allow.has(name) || mode === 'allow') return { action: 'allow' };
      return {
        action: mode === 'block' ? 'deny' : 'approve',
        reason: `tool "${name}" called from tainted (untrusted-content) context`,
      };
    },
  };
}

/** Fold a text value through a guardrail chain (throws GuardrailError on block). */
export function applyTextGuards(text: string, role: 'input' | 'output', guardrails: Guardrail[]): string {
  let out = text;
  for (const g of guardrails) {
    if (g.onText) out = g.onText(out, { role }) ?? out;
  }
  return out;
}

/** Combine tool-call decisions; the most restrictive wins (deny > approve > allow). */
export function decideToolCall(ctx: ToolCallContext, guardrails: Guardrail[]): ToolDecision {
  let decision: ToolDecision = { action: 'allow' };
  for (const g of guardrails) {
    const d = g.onToolCall?.(ctx);
    if (!d) continue;
    if (d.action === 'deny') return d;
    if (d.action === 'approve' && decision.action === 'allow') decision = d;
  }
  return decision;
}

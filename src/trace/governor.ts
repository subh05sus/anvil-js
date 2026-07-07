import type { Usage } from '../llm/types.js';

export type BreachAction = 'block' | 'degrade' | 'approve';

export interface BudgetConfig {
  /** Hard USD cap for this scope (route/user/run). */
  maxUsd?: number;
  /** Hard total-token cap. */
  maxTokens?: number;
  /**
   * What to do when a cap is hit before a call. 'block' throws
   * BudgetExceededError. 'degrade' and 'approve' are surfaced via `onBreach`
   * for the caller to handle (cheaper model / HITL) — full wiring in M5.
   */
  onBreach?: BreachAction;
}

export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly spentTokens: number;
  readonly limit: BudgetConfig;
  constructor(message: string, ctx: { spentUsd: number; spentTokens: number; limit: BudgetConfig }) {
    super(message);
    this.name = 'BudgetExceededError';
    this.spentUsd = ctx.spentUsd;
    this.spentTokens = ctx.spentTokens;
    this.limit = ctx.limit;
  }
}

/**
 * Per-scope token/cost budget cap (PRD §6.15). Accumulates spend and gates the
 * next call. Counts partial usage from aborted streams too, so a disconnect
 * mid-run doesn't create a blind spot.
 */
export class CostGovernor {
  #config: BudgetConfig;
  #spentUsd = 0;
  #spentTokens = 0;
  #onBreach?: (info: { action: BreachAction; spentUsd: number; spentTokens: number }) => void;

  constructor(config: BudgetConfig, onBreach?: (info: { action: BreachAction; spentUsd: number; spentTokens: number }) => void) {
    this.#config = config;
    this.#onBreach = onBreach;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }
  get spentTokens(): number {
    return this.#spentTokens;
  }

  record(usage: Usage, costUsd = 0): void {
    this.#spentUsd += costUsd;
    this.#spentTokens += usage.inputTokens + usage.outputTokens;
  }

  /** Whether spend is already at/over a cap. */
  isOverBudget(): boolean {
    const { maxUsd, maxTokens } = this.#config;
    return (maxUsd !== undefined && this.#spentUsd >= maxUsd) || (maxTokens !== undefined && this.#spentTokens >= maxTokens);
  }

  /**
   * Gate the next call. Throws on breach when action is 'block'; otherwise
   * notifies `onBreach` and returns the action so the caller can degrade/approve.
   */
  assertWithinBudget(): BreachAction | 'ok' {
    if (!this.isOverBudget()) return 'ok';
    const action = this.#config.onBreach ?? 'block';
    if (action === 'block') {
      throw new BudgetExceededError(
        `Budget exceeded: spent $${this.#spentUsd.toFixed(4)} / ${this.#spentTokens} tokens`,
        { spentUsd: this.#spentUsd, spentTokens: this.#spentTokens, limit: this.#config },
      );
    }
    this.#onBreach?.({ action, spentUsd: this.#spentUsd, spentTokens: this.#spentTokens });
    return action;
  }
}

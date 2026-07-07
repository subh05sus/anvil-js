import type { StateStore } from '../store/index.js';
import type { GenerateResult, ModelMessage } from '../llm/types.js';

/** Thrown from a tool via `meta.requestApproval(payload)` to suspend the run (PRD §6.7). */
export class ApprovalRequiredError extends Error {
  readonly callId: string;
  readonly payload: unknown;
  constructor(callId: string, payload: unknown) {
    super('Approval required');
    this.name = 'ApprovalRequiredError';
    this.callId = callId;
    this.payload = payload;
  }
}

export type CheckpointStatus = 'running' | 'suspended' | 'done';

/**
 * A durable snapshot of an agent run (PRD §6.20). Written after each completed
 * iteration and on suspend, so a crash/redeploy resumes from the last step
 * instead of restarting (and re-billing). `approvals` fences already-executed
 * tool calls so resume never re-runs a side effect.
 */
export interface AgentCheckpoint {
  version: 1;
  runId: string;
  status: CheckpointStatus;
  messages: ModelMessage[];
  iterations: number;
  totalUsage: GenerateResult['usage'];
  totalCostUsd: number;
  /** Results of tool calls that already ran — keyed by call id (side-effect fence). */
  approvals?: Record<string, unknown>;
  /** Set when suspended for human approval. */
  pending?: { callId: string; payload: unknown };
  finalText?: string;
  updatedAt: number;
}

const KEY_PREFIX = 'anvil:agent:run:';

/** Persists/loads agent checkpoints in a StateStore under a stable key. */
export class Checkpointer {
  #store: StateStore;
  readonly runId: string;

  constructor(store: StateStore, runId: string) {
    this.#store = store;
    this.runId = runId;
  }

  #key(): string {
    return KEY_PREFIX + this.runId;
  }

  async save(cp: Omit<AgentCheckpoint, 'version' | 'runId' | 'updatedAt'>): Promise<void> {
    await this.#store.set(this.#key(), { version: 1, runId: this.runId, updatedAt: Date.now(), ...cp });
  }

  async load(): Promise<AgentCheckpoint | undefined> {
    return (await this.#store.get<AgentCheckpoint>(this.#key())) ?? undefined;
  }

  async delete(): Promise<void> {
    await this.#store.delete(this.#key());
  }
}

/** List run ids with a persisted checkpoint (e.g. to show a pending-approvals queue). */
export async function listRuns(store: StateStore): Promise<string[]> {
  const keys = await store.list(KEY_PREFIX);
  return keys.map((k) => k.slice(KEY_PREFIX.length));
}

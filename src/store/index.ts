/**
 * State store adapters (PRD §6.7, §6.10, §6.20) — lands in M4/M5.
 * One StoreAdapter interface for traces, HITL state, memory, checkpoints,
 * and prompt versions. SQLite default; Redis/Postgres adapters.
 */
export const MODULE_STATUS = 'planned:M4' as const;

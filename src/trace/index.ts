/**
 * Agent observability & tracing (PRD §6.6, §6.25) — lands in M4.
 * TraceContext span tree over model/tool/retrieval calls, SQLite-backed,
 * with the /_anvil dashboard and OTel GenAI export.
 */
export const MODULE_STATUS = 'planned:M4' as const;

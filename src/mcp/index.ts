/**
 * MCP auto-exposure (PRD §6.1) — lands in M2.
 * Routes with `meta.mcp.expose = true` will be served as MCP tools over
 * Streamable HTTP (primary) and stdio, driven by the same route manifest
 * used by the HTTP router.
 */
export const MODULE_STATUS = 'planned:M2' as const;

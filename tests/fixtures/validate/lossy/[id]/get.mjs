import { z } from 'zod';

// MCP-exposed, but a field uses .transform() — not serializable to JSON Schema.
export const meta = { mcp: { expose: true, description: 'Lossy schema tool' } };
export const paramsSchema = z.object({ id: z.string() });
export const bodySchema = z.object({ when: z.string().transform((s) => new Date(s)) });

export default function handler() {
  return {};
}

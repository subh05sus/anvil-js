import { z } from 'zod';

export const meta = { mcp: { expose: true, description: 'Fetch a widget by id' } };
export const paramsSchema = z.object({ id: z.string().uuid() });

export default function handler(ctx) {
  return { id: ctx.params.id };
}

import { HttpError, type Context } from 'anvil-js';
import { z } from 'zod';
import { NOTES } from './data';

export const meta = { mcp: { expose: true, description: 'Create a new note' } };
export const bodySchema = z.object({ text: z.string().min(1) });

export default async function handler(ctx: Context) {
  const body = await ctx.body<{ text?: string }>();
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) throw new HttpError(400, parsed.error.message);
  const note = { id: String(NOTES.length + 1), text: parsed.data.text };
  NOTES.push(note);
  return ctx.json({ note }, { status: 201 });
}

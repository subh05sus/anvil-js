import { HttpError, type Context } from 'anvil-js';
import { z } from 'zod';
import { NOTES } from '../data';

export const meta = { mcp: { expose: true, description: 'Fetch a note by id' } };
export const paramsSchema = z.object({ id: z.string() });

export default function handler(ctx: Context) {
  const note = NOTES.find((n) => n.id === ctx.params.id);
  if (!note) throw new HttpError(404, `No note with id "${ctx.params.id}"`);
  return note;
}

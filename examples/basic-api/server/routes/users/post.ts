import { HttpError, type Context } from 'anvil';

export default async function handler(ctx: Context) {
  const body = await ctx.body<{ name?: string }>();
  if (typeof body !== 'object' || body === null || !body.name) {
    throw new HttpError(400, 'Expected JSON body with a "name" field');
  }
  return ctx.json({ created: { id: Date.now().toString(36), name: body.name } }, { status: 201 });
}

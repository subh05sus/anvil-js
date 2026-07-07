import { z } from 'zod';

export const meta = { mcp: { expose: true, description: 'Fetch a widget by id' } };
export const paramsSchema = z.object({ id: z.string() });

const WIDGETS = { '1': { id: '1', kind: 'sprocket' }, '2': { id: '2', kind: 'flange' } };

export default function handler(ctx) {
  const widget = WIDGETS[ctx.params.id];
  if (!widget) return ctx.json({ error: 'not found' }, { status: 404 });
  return widget;
}

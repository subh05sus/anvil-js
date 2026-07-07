import type { Context } from 'anvil-js';

export default function handler(ctx: Context) {
  return { requested: ctx.params.path, segments: ctx.params.path?.split('/') };
}

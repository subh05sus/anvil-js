import type { Context } from 'anvil-sdk';

export default function handler(ctx: Context) {
  return { requested: ctx.params.path, segments: ctx.params.path?.split('/') };
}

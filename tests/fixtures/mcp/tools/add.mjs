import { z } from 'zod';

export const description = 'Add two numbers';
export const inputSchema = z.object({ a: z.number(), b: z.number() });

export default async function add(args) {
  return { sum: args.a + args.b };
}

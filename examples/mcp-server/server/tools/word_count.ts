import { z } from 'zod';

export const description = 'Count words and characters in a piece of text';
export const inputSchema = z.object({ text: z.string() });

export default async function wordCount(args: { text: string }) {
  const words = args.text.trim().split(/\s+/).filter(Boolean);
  return { words: words.length, characters: args.text.length };
}

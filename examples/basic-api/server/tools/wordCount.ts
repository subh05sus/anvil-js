import { z } from 'zod';

// A standalone tool (not tied to an HTTP route). `anvil mcp` exposes it
// alongside route-derived tools from the same command.
export const description = 'Count the words in a piece of text';
export const inputSchema = z.object({ text: z.string() });

export default async function wordCount(args: { text: string }) {
  const words = args.text.trim().split(/\s+/).filter(Boolean);
  return { words: words.length, characters: args.text.length };
}

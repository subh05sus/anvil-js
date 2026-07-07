import { NOTES } from './data';

export const meta = { mcp: { expose: true, description: 'List all notes' } };

export default function handler() {
  return { notes: NOTES };
}

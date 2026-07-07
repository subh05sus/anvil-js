import { z } from 'zod';

// Folder param is [id] but the schema calls it userId — a params-missing +
// params-extra pair.
export const paramsSchema = z.object({ userId: z.string() });

export default function handler() {
  return {};
}

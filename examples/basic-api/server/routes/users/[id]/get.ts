import { HttpError, type Context } from 'anvil';
import { USERS } from '../data';

// MCP exposure metadata — consumed by `anvil mcp` starting in M2.
export const meta = { mcp: { expose: true, description: 'Fetch a user by ID' } };

export default function handler(ctx: Context) {
  const user = USERS.find((u) => u.id === ctx.params.id);
  if (!user) throw new HttpError(404, `No user with id "${ctx.params.id}"`);
  return user;
}

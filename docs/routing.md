# Routing

## File conventions

| Pattern | Meaning |
|---|---|
| `get.ts`, `post.ts`, `put.ts`, `patch.ts`, `delete.ts`, `head.ts`, `options.ts` | One file per HTTP verb |
| `agent.ts` | Agent route — served as `POST` (see [agents.md](./agents.md)) |
| `[id]/` | Dynamic segment — `ctx.params.id` |
| `[...path]/` | Catch-all segment — `ctx.params.path` is the joined rest of the URL |
| `(group)/` | Route group — contributes no URL segment, just organizes files |
| `_middleware.ts` | Scoped middleware, composed root → leaf |

Route matching precedence is structural: **static > dynamic > catch-all**, with backtracking (`/users/new` and `/users/[id]` can coexist; `/a/x` and `/a/[b]/c` can too).

## Handlers

```ts
import type { Context } from 'anvil-js';

export default async function handler(ctx: Context) {
  ctx.params;           // route params, typed by folder structure
  ctx.query;            // parsed query string (repeated keys → arrays)
  await ctx.body();     // JSON / FormData / text, content-type aware, cached
  return { ok: true };  // objects → JSON, strings → text/plain, null → 204
  // or: return ctx.json(...) / ctx.text(...) / ctx.redirect(...) / ctx.stream(...)
}
```

## Middleware

`_middleware.ts` exports a function (or array of functions) run around every route beneath it, outermost-first:

```ts
import type { Middleware } from 'anvil-js';

const auth: Middleware = async (ctx, next) => {
  if (!ctx.headers.get('authorization')) throw new HttpError(401);
  return next();
};

export default auth;
```

A **root** `_middleware.ts` also runs for unmatched paths — this is where static file serving and dashboards mount:

```ts
import { serveStatic } from 'anvil-js';
export default [logger, serveStatic({ dir: 'public' })];
```

## Errors

```ts
import { HttpError } from 'anvil-js';
throw new HttpError(404, 'Not found');       // exposed to the client
throw new HttpError(500, 'internal detail'); // 5xx messages are hidden unless dev mode
```

## Compile-time validation

`anvil lint` checks:
- `paramsSchema` keys match the route's dynamic segments (no drift between folder and schema)
- Any schema on an MCP-exposed route (`paramsSchema`/`bodySchema`/`querySchema`/`outputSchema`) converts losslessly to JSON Schema — `.transform()`/`.refine()` on an exposed schema is a **build error**, not a runtime surprise
- MCP-exposed routes have a `meta.mcp.description` (warning if missing)

Run it in CI. `anvil build` also fails hard on structural route conflicts (duplicate routes, ambiguous dynamic segments, and — because Windows is case-insensitive and Linux isn't — case-only path collisions).

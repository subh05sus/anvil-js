# Anvil example: MCP server (zero extra code)

Demonstrates the core wedge: **REST routes are also MCP tools.** No separate MCP server codebase, no duplicated schemas.

## Run it

```bash
npm install
npm run mcp          # Streamable HTTP on :3100/mcp
# or
npm run mcp:stdio     # stdio, for Claude Desktop / local MCP clients
```

From a fresh `npm install` to a working MCP server: under a minute (PRD §9 success metric).

## What's exposed

- `server/routes/notes/get.ts` — `GET /notes` → tool `get_notes` (list notes)
- `server/routes/notes/[id]/get.ts` — `GET /notes/:id` → tool `get_notes_by_id` (fetch one, with a `paramsSchema` checked by `anvil lint`)
- `server/routes/notes/post.ts` — `POST /notes` → tool `post_notes` (create a note, `bodySchema` validated)
- `server/tools/word_count.ts` — a standalone tool with no HTTP route at all

Every schema is a single Zod definition — the same one that validates the HTTP request also becomes the tool's JSON Schema (`anvil/compiler`'s `zodToJsonSchema`). Edit the route, the tool changes with it.

## Try it

```bash
npm run mcp
curl -s -X POST http://localhost:3100/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

curl -s -X POST http://localhost:3100/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_notes_by_id","arguments":{"id":"1"}}}'
```

## Validate before shipping

```bash
npm run lint
```

`anvil lint` checks that every `paramsSchema` matches its route's dynamic segments, and that every MCP-exposed route's schemas convert losslessly to JSON Schema (catches `.transform()`/`.refine()` on exposed schemas at build time, not at call time).

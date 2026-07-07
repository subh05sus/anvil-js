export type TemplateId = 'basic' | 'mcp' | 'agent';

export interface TemplateFile {
  /** Path relative to the project root. */
  path: string;
  content: string;
}

export interface Template {
  id: TemplateId;
  label: string;
  description: string;
  /** Extra dependencies beyond anvil + zod. */
  extraDependencies?: Record<string, string>;
  /** Extra package.json scripts beyond the shared base set. */
  extraScripts?: Record<string, string>;
  files: TemplateFile[];
  /** Printed after scaffolding, above the generic "next steps". */
  hint: string;
}

const GET_HANDLER = `export default function handler() {
  return { message: 'Hello from Anvil!' };
}
`;

const BASIC_USER_ROUTE = `import { HttpError, type Context } from 'anvil-js';

const USERS = [{ id: '1', name: 'Ada Lovelace' }];

export default function handler(ctx: Context) {
  const user = USERS.find((u) => u.id === ctx.params.id);
  if (!user) throw new HttpError(404, \`No user "\${ctx.params.id}"\`);
  return user;
}
`;

const MCP_USER_ROUTE = `import { HttpError, type Context } from 'anvil-js';
import { z } from 'zod';

// Exposed as an MCP tool (get_users_by_id) with zero extra code — run
// \`npx anvil mcp\` and call it over Streamable HTTP or stdio.
export const meta = { mcp: { expose: true, description: 'Fetch a user by ID' } };
export const paramsSchema = z.object({ id: z.string() });

const USERS = [{ id: '1', name: 'Ada Lovelace' }];

export default function handler(ctx: Context) {
  const user = USERS.find((u) => u.id === ctx.params.id);
  if (!user) throw new HttpError(404, \`No user "\${ctx.params.id}"\`);
  return user;
}
`;

const MCP_TOOL = `import { z } from 'zod';

// A standalone tool with no HTTP route — also served by \`anvil mcp\`.
export const description = 'Count words in a piece of text';
export const inputSchema = z.object({ text: z.string() });

export default async function wordCount(args: { text: string }) {
  const words = args.text.trim().split(/\\s+/).filter(Boolean);
  return { words: words.length, characters: args.text.length };
}
`;

const AGENT_ROUTE = `import { defineAgent } from 'anvil-js/agent';
import { LlmClient, MockDriver } from 'anvil-js/llm';

// MockDriver runs with no API key so this route works out of the box.
// Swap in \`new AnthropicDriver({ apiKey: process.env.ANTHROPIC_API_KEY })\`
// (npm install @anthropic-ai/sdk) for a real model.
const client = new LlmClient({
  drivers: [new MockDriver({ prefix: 'claude', defaultText: 'Hello! Ask me anything.' })],
  defaultModel: 'claude-opus-4-8',
});

export default defineAgent({
  client,
  system: 'You are a helpful assistant.',
});
`;

export const TEMPLATES: Template[] = [
  {
    id: 'basic',
    label: 'Basic API',
    description: 'A minimal REST API — one static route, one dynamic route.',
    hint: 'Run `npm run dev`, then `curl http://localhost:3000/users/1`.',
    files: [
      { path: 'server/routes/get.ts', content: GET_HANDLER },
      { path: 'server/routes/users/[id]/get.ts', content: BASIC_USER_ROUTE },
    ],
  },
  {
    id: 'mcp',
    label: 'MCP server',
    description: 'REST routes exposed as MCP tools, plus a standalone tool.',
    hint: 'Run `npx anvil mcp`, then send it a `tools/list` JSON-RPC call.',
    extraScripts: { mcp: 'anvil mcp' },
    files: [
      { path: 'server/routes/get.ts', content: GET_HANDLER },
      { path: 'server/routes/users/[id]/get.ts', content: MCP_USER_ROUTE },
      { path: 'server/tools/word_count.ts', content: MCP_TOOL },
    ],
  },
  {
    id: 'agent',
    label: 'Agent route',
    description: 'A streaming agent endpoint using the AI SDK data-stream protocol.',
    hint: 'Run `npm run dev`, then POST to `/chat` with `{"messages":[{"role":"user","content":"hi"}]}`.',
    files: [
      { path: 'server/routes/get.ts', content: GET_HANDLER },
      { path: 'server/routes/chat/agent.ts', content: AGENT_ROUTE },
    ],
  },
];

export function getTemplate(id: TemplateId): Template {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown template "${id}". Valid: ${TEMPLATES.map((x) => x.id).join(', ')}`);
  return t;
}

export const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true
  }
}
`;

export const GITIGNORE = `node_modules/
dist/
.gen/
.anvil/
*.log
`;

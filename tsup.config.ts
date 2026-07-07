import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'compiler/index': 'src/compiler/index.ts',
    'cli/index': 'src/cli/index.ts',
    'mcp/index': 'src/mcp/index.ts',
    'llm/index': 'src/llm/index.ts',
    'agent/index': 'src/agent/index.ts',
    'trace/index': 'src/trace/index.ts',
    'store/index': 'src/store/index.ts',
    'tools/index': 'src/tools/index.ts',
    'eval/index': 'src/eval/index.ts',
    'prompt/index': 'src/prompt/index.ts',
    'memory/index': 'src/memory/index.ts',
    'rag/index': 'src/rag/index.ts',
    'schedule/index': 'src/schedule/index.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: true,
  sourcemap: true,
  clean: true,
});

import { MemoryTraceStore, Tracer } from 'anvil-js/trace';

// Shared trace store + tracer for the example. In-memory so it runs with no
// native deps; swap `MemoryTraceStore` for `await SqliteTraceStore.open()` to
// persist across restarts, or pass `otlpHttpExporter({url})` as `onExport`.
export const traceStore = new MemoryTraceStore();
export const tracer = new Tracer(traceStore);

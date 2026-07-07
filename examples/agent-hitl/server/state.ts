import { MemoryStateStore } from 'anvil-sdk/store';

// Shared across the agent route and the approve route so a suspended run's
// checkpoint is visible to both. Swap for `await SqliteStateStore.open(...)`
// (anvil/store) to persist checkpoints across a server restart.
export const stateStore = new MemoryStateStore();

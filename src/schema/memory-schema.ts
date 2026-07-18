import type { DatabasePool } from '../types.js';
import { initializeMemoryColumns, initializeMemoryTable } from './memory-table-schema.js';
import {
  initializeMemoryChunks,
  initializeMemoryIndexes,
  initializeMemoryMerges,
  initializeMemorySearch,
} from './memory-support-schema.js';

export { validateEmbeddingColumnContract } from './memory-embedding-contract.js';

export async function initializeMemorySchema(pool: DatabasePool, dimensions: number): Promise<void> {
  await initializeMemoryTable(pool, dimensions);
  await initializeMemoryColumns(pool);
  await initializeMemoryChunks(pool, dimensions);
  await initializeMemoryIndexes(pool);
  await initializeMemorySearch(pool);
  await initializeMemoryMerges(pool);
}

import type { DatabasePool } from '../types.js';
import { ensureEmbeddingColumnContract } from './memory-embedding-contract.js';
import { initializeMemoryColumns, initializeMemoryTable } from './memory-table-schema.js';
import {
  initializeMemoryChunks,
  initializeMemoryIndexes,
  initializeMemoryMerges,
  initializeMemorySearch,
} from './memory-support-schema.js';

export { ensureEmbeddingColumnContract } from './memory-embedding-contract.js';

export async function initializeMemorySchema(pool: DatabasePool): Promise<void> {
  await initializeMemoryTable(pool);
  await ensureEmbeddingColumnContract(pool);
  await initializeMemoryColumns(pool);
  await initializeMemoryChunks(pool);
  await initializeMemoryIndexes(pool);
  await initializeMemorySearch(pool);
  await initializeMemoryMerges(pool);
}

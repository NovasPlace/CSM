import type { DatabasePool } from '../../types.js';
import { initializeSqliteCore } from './core.js';
import { initializeSqliteEvents } from './events.js';
import { initializeSqliteLivingState } from './living-state.js';
import { initializeSqliteMemorySupport } from './memory-support.js';

export async function initializeMinimalSqliteSchema(pool: DatabasePool): Promise<void> {
  await initializeSqliteCore(pool);
  await initializeSqliteMemorySupport(pool);
  await initializeSqliteEvents(pool);
  await initializeSqliteLivingState(pool);
}

import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseProvider,
  DatabaseStartupState,
} from './types.js';
import { formatDatabaseDiagnostic } from './database-diagnostic.js';

export async function diagnoseDatabase(
  pool: DatabasePool | null,
  provider: DatabaseProvider,
  state: DatabaseStartupState,
  startupError?: string,
): Promise<DatabaseDiagnostics> {
  const checkedAt = new Date().toISOString();
  const readiness = await probeReadiness(pool, state);
  return {
    provider,
    checkedAt,
    startup: { state, ...(startupError ? { error: startupError } : {}) },
    liveness: { status: 'pass' },
    readiness,
    ...(pool?.getStats ? { pool: pool.getStats() } : {}),
  };
}

async function probeReadiness(
  pool: DatabasePool | null,
  state: DatabaseStartupState,
): Promise<DatabaseDiagnostics['readiness']> {
  const startedAt = performance.now();
  if (!pool || state !== 'ready') {
    return { status: 'fail', latencyMs: elapsedMs(startedAt), reason: 'not_connected' };
  }
  try {
    await pool.query('SELECT 1 AS healthy');
    return { status: 'pass', latencyMs: elapsedMs(startedAt) };
  } catch (error) {
    return {
      status: 'fail',
      latencyMs: elapsedMs(startedAt),
      reason: 'probe_failed',
      error: formatDatabaseDiagnostic(error),
    };
  }
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 100) / 100);
}

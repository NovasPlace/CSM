import type { Snapshot } from './backup-drill-data.js';

export interface BackupDrillConfig {
  memoryCount: number;
  maxRtoMs: number;
  maxDataLoss: number;
}

export interface BackupDrillTimings {
  backupMs: number;
  restoreAndValidateMs: number;
  totalMs: number;
}

export interface BackupDrillReport {
  status: 'pass';
  source: Snapshot;
  restored: Snapshot;
  timings: BackupDrillTimings;
  rpo: { recordsLost: number };
  cleanupVerified: true;
}

export function readBackupDrillConfig(
  env: NodeJS.ProcessEnv = process.env,
): BackupDrillConfig {
  return {
    memoryCount: readInteger(env, 'CSM_DRILL_MEMORY_COUNT', 1, 1, 1_000_000),
    maxRtoMs: readInteger(env, 'CSM_DRILL_MAX_RTO_MS', 0, 0, 86_400_000),
    maxDataLoss: readInteger(env, 'CSM_DRILL_MAX_DATA_LOSS', 0, 0, 1_000_000),
  };
}

export function buildBackupDrillReport(
  source: Snapshot,
  restored: Snapshot,
  timings: BackupDrillTimings,
): BackupDrillReport {
  return {
    status: 'pass',
    source,
    restored,
    timings,
    rpo: { recordsLost: Math.max(0, source.memories - restored.memories) },
    cleanupVerified: true,
  };
}

export function assertBackupDrillThresholds(
  report: BackupDrillReport,
  config: BackupDrillConfig,
): void {
  if (report.rpo.recordsLost > config.maxDataLoss) {
    throw new Error(`Backup drill data loss ${report.rpo.recordsLost} exceeds ${config.maxDataLoss}`);
  }
  if (config.maxRtoMs > 0 && report.timings.restoreAndValidateMs > config.maxRtoMs) {
    throw new Error(`Backup drill RTO ${report.timings.restoreAndValidateMs}ms exceeds ${config.maxRtoMs}ms`);
  }
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}`);
  return value;
}

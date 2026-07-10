import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertBackupDrillThresholds,
  buildBackupDrillReport,
  readBackupDrillConfig,
} from '../scripts/backup-drill-config.js';

const source = { sessions: 1, memories: 50_000, migrations: 21, sentinel: 'backup-restore-sentinel' };
const restored = { ...source };

it('uses a safe one-record smoke-drill default', () => {
  assert.deepEqual(readBackupDrillConfig({}), {
    memoryCount: 1,
    maxRtoMs: 0,
    maxDataLoss: 0,
  });
});

it('parses scale and recovery thresholds strictly', () => {
  assert.deepEqual(readBackupDrillConfig({
    CSM_DRILL_MEMORY_COUNT: '50000',
    CSM_DRILL_MAX_RTO_MS: '30000',
    CSM_DRILL_MAX_DATA_LOSS: '0',
  }), { memoryCount: 50_000, maxRtoMs: 30_000, maxDataLoss: 0 });
  assert.throws(() => readBackupDrillConfig({ CSM_DRILL_MEMORY_COUNT: '-1' }), /integer/);
});

it('builds a machine-readable zero-loss report', () => {
  const report = buildBackupDrillReport(source, restored, {
    backupMs: 100,
    restoreAndValidateMs: 200,
    totalMs: 400,
  });
  assert.equal(report.rpo.recordsLost, 0);
  assert.equal(report.cleanupVerified, true);
  assert.doesNotThrow(() => assertBackupDrillThresholds(report, {
    memoryCount: 50_000,
    maxRtoMs: 1_000,
    maxDataLoss: 0,
  }));
});

it('rejects RPO and RTO threshold breaches', () => {
  const lossReport = buildBackupDrillReport(source, { ...restored, memories: 49_999 }, {
    backupMs: 100,
    restoreAndValidateMs: 2_000,
    totalMs: 2_500,
  });
  assert.throws(
    () => assertBackupDrillThresholds(lossReport, { memoryCount: 50_000, maxRtoMs: 0, maxDataLoss: 0 }),
    /data loss/,
  );
  assert.throws(
    () => assertBackupDrillThresholds(lossReport, { memoryCount: 50_000, maxRtoMs: 1_000, maxDataLoss: 2 }),
    /RTO/,
  );
});

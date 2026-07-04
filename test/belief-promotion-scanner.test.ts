import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefPromotionScanner } from '../dist/belief-promotion-scanner.js';

function makePacketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 1,
    session_id: overrides.session_id ?? 'sess-test',
    project_id: overrides.project_id ?? null,
    entry_type: overrides.entry_type ?? 'tool_execution',
    signals: overrides.signals ?? JSON.stringify({ toolName: 'read' }),
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

function makePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  return {
    query: mock.fn((sql: string, params?: unknown[]) => {
      return Promise.resolve(handler(sql, params));
    }),
    getDialect: () => 'pg' as const,
  };
}

function makeScanner(pool: { query: unknown; getDialect: () => 'pg' }) {
  return new BeliefPromotionScanner(pool as any);
}

describe('BeliefPromotionScanner', () => {
  it('scans no packets produces zero candidates', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.packetsScanned, 0);
    assert.equal(report.patternsFound, 0);
    assert.equal(report.candidates.length, 0);
  });

  it('1 packet does NOT create a candidate (below minPacketCount)', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'read' }) })],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true, minPacketCount: 2 });

    assert.equal(report.packetsScanned, 1);
    assert.equal(report.patternsFound, 1);
    assert.equal(report.candidates.length, 0, 'single packet should not produce a candidate');
  });

  it('2 similar tool_execution packets create a candidate_preference', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'read' }) }),
            makePacketRow({ id: 2, signals: JSON.stringify({ toolName: 'read' }) }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.packetsScanned, 2);
    assert.equal(report.patternsFound, 1);
    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'candidate_preference');
    assert.equal(report.candidates[0].dedupKey, 'tool:read:ok');
    assert.equal(report.candidates[0].eventCount, 2);
    assert.equal(report.candidates[0].confidence, 0.3);
  });

  it('3 similar packets produce higher confidence', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'write' }) }),
            makePacketRow({ id: 2, signals: JSON.stringify({ toolName: 'write' }) }),
            makePacketRow({ id: 3, signals: JSON.stringify({ toolName: 'write' }) }),
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].eventCount, 3);
    assert.equal(report.candidates[0].confidence, 0.4);
  });

  it('5+ similar packets mark candidate as promotion-worthy (confidence >= 0.7)', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: Array.from({ length: 6 }, (_, i) =>
            makePacketRow({ id: i + 1, signals: JSON.stringify({ toolName: 'edit' }) }),
          ),
          rowCount: 6,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].eventCount, 6);
    assert.equal(report.candidates[0].reinforcementCount, 6);
    assert.ok(report.candidates[0].confidence >= 0.7, `expected confidence >= 0.7, got ${report.candidates[0].confidence}`);
  });

  it('contradiction increments contradicted_count and reduces confidence', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'bash' }) }),
            makePacketRow({ id: 2, signals: JSON.stringify({ toolName: 'bash', exitCode: 1 }) }),
            makePacketRow({ id: 3, signals: JSON.stringify({ toolName: 'bash' }) }),
            makePacketRow({ id: 4, signals: JSON.stringify({ toolName: 'bash', error: 'command failed' }) }),
          ],
          rowCount: 4,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.candidates.length, 2, 'two patterns: ok + fail');
    const failCandidate = report.candidates.find(c => c.dedupKey === 'tool:bash:fail');
    const okCandidate = report.candidates.find(c => c.dedupKey === 'tool:bash:ok');
    assert.ok(failCandidate, 'should have a fail pattern candidate');
    assert.ok(okCandidate, 'should have an ok pattern candidate');

    assert.equal(failCandidate?.eventCount, 2);
    assert.equal(failCandidate?.contradictedCount, 2);
    assert.equal(failCandidate?.reinforcementCount, 0);

    assert.equal(okCandidate?.eventCount, 2);
    assert.equal(okCandidate?.reinforcementCount, 2);
  });

  it('error packets produce candidate_belief with contradictedCount', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({
              id: 1,
              entry_type: 'error',
              signals: JSON.stringify({ toolName: 'bash', error: 'command not found' }),
            }),
            makePacketRow({
              id: 2,
              entry_type: 'error',
              signals: JSON.stringify({ toolName: 'bash', error: 'command not found' }),
            }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'candidate_belief');
    assert.ok(report.candidates[0].dedupKey.includes('command'));
    assert.equal(report.candidates[0].contradictedCount, 2);
    assert.equal(report.candidates[0].reinforcementCount, 0);
  });

  it('duplicate scans are idempotent (same data produces same candidates)', async () => {
    let queryCount = 0;
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        queryCount++;
        return {
          rows: [
            makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'read' }) }),
            makePacketRow({ id: 2, signals: JSON.stringify({ toolName: 'read' }) }),
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('INSERT INTO memory_candidate_queue')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);

    const report1 = await scanner.scan({ dryRun: false, minPacketCount: 1 });
    const report2 = await scanner.scan({ dryRun: false, minPacketCount: 1 });

    assert.equal(report1.candidates.length, 1);
    assert.equal(report2.candidates.length, 1);
    assert.equal(report1.candidates[0].dedupKey, report2.candidates[0].dedupKey);
    assert.equal(report1.candidates[0].eventCount, 2);
    assert.equal(report2.candidates[0].eventCount, 2);
  });

  it('packet layer remains unchanged (read-only scan)', async () => {
    const writtenTables: string[] = [];
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO') || sql.includes('UPDATE') || sql.includes('DELETE')) {
        const table = sql.match(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/i)?.[1] ?? 'unknown';
        writtenTables.push(table);
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    await scanner.scan({ dryRun: true });

    const packetWrites = writtenTables.filter(t => t === 'experience_packets');
    assert.equal(packetWrites.length, 0, 'experience_packets should not be written to during scan');
  });

  it('scanner must NOT write to belief_candidates table (regression)', async () => {
    const writtenTables: string[] = [];
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'read' }) }),
            makePacketRow({ id: 2, signals: JSON.stringify({ toolName: 'read' }) }),
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('INSERT INTO') || sql.includes('UPDATE') || sql.includes('DELETE')) {
        const table = sql.match(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(\w+)/i)?.[1] ?? 'unknown';
        writtenTables.push(table);
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    await scanner.scan({ dryRun: false, minPacketCount: 1 });

    const beliefWrites = writtenTables.filter(t => t === 'belief_candidates');
    assert.equal(beliefWrites.length, 0, 'scanner must not write to belief_candidates table');
    const queueWrites = writtenTables.filter(t => t === 'memory_candidate_queue');
    assert.ok(queueWrites.length > 0, 'scanner should write to memory_candidate_queue');
  });

  it('milestone packets produce candidate_worldview', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({
              id: 1,
              entry_type: 'milestone',
              signals: JSON.stringify({ intent: 'completed the feature' }),
            }),
            makePacketRow({
              id: 2,
              entry_type: 'milestone',
              signals: JSON.stringify({ intent: 'all tests pass' }),
            }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'candidate_worldview');
    assert.equal(report.candidates[0].eventCount, 2);
    assert.equal(report.candidates[0].reinforcementCount, 2);
  });

  it('loop_signal packets produce candidate_drift_warning', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({
              id: 1,
              entry_type: 'loop_signal',
              signals: JSON.stringify({ toolName: 'bash', callCount: 5 }),
            }),
            makePacketRow({
              id: 2,
              entry_type: 'loop_signal',
              signals: JSON.stringify({ toolName: 'bash', callCount: 7 }),
            }),
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: true });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'candidate_drift_warning');
    assert.equal(report.candidates[0].dedupKey, 'loop:bash');
  });

  it('respects maxPerType limit', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: Array.from({ length: 6 }, (_, i) =>
            makePacketRow({
              id: i + 1,
              signals: JSON.stringify({ toolName: i < 3 ? 'read' : 'write' }),
            }),
          ),
          rowCount: 6,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({ dryRun: false, maxPerType: 1, minPacketCount: 1 });

    const beliefCount = report.byType['candidate_preference'] ?? 0;
    assert.equal(beliefCount, 1, 'should only produce 1 candidate with maxPerType=1');
  });

  it('filters by allowed types', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('FROM experience_packets')) {
        return {
          rows: [
            makePacketRow({ id: 1, signals: JSON.stringify({ toolName: 'read' }) }),
            makePacketRow({ id: 2, signals: JSON.stringify({ toolName: 'read' }) }),
            makePacketRow({
              id: 3,
              entry_type: 'milestone',
              signals: JSON.stringify({ intent: 'all done' }),
            }),
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const report = await scanner.scan({
      dryRun: true,
      types: ['candidate_preference'],
      minPacketCount: 1,
    });

    assert.equal(report.candidates.length, 1);
    assert.equal(report.candidates[0].candidateType, 'candidate_preference');
  });

  it('report aggregates counts by type and status', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('GROUP BY candidate_type, status')) {
        return {
          rows: [
            { candidate_type: 'candidate_belief', status: 'pending', count: 3 },
            { candidate_type: 'candidate_preference', status: 'dismissed', count: 1 },
            { candidate_type: 'candidate_drift_warning', status: 'pending', count: 2 },
          ],
          rowCount: 3,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const scanner = makeScanner(pool);
    const r = await scanner.report();

    assert.equal(r.total, 6);
    assert.equal(r.byType['candidate_belief'], 3);
    assert.equal(r.byType['candidate_preference'], 1);
    assert.equal(r.byType['candidate_drift_warning'], 2);
    assert.equal(r.byStatus['pending'], 5);
    assert.equal(r.byStatus['dismissed'], 1);
  });
});

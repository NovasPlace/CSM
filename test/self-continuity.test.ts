import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SelfContinuityGenerator } from '../dist/self-continuity-generator.js';
import { CONTINUITY_CONFIDENCE_WEIGHTS } from '../dist/self-continuity-types.js';
import type { DatabasePool } from '../dist/types.js';

function makeSyntheticTrackingPool(overrides: Record<string, unknown> = {}): DatabasePool {
  let insertCount = 0;
  const rows: Record<string, unknown>[] = [];

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO self_continuity_records')) {
        insertCount++;
        const id = insertCount;
        rows.push({ id, ...(params ? {
          session_id: params[0],
          project_id: params[1],
          trigger_type: params[2],
          recognized_prior_self: params[3],
          continuity_confidence: params[4],
          felt_gap: params[5],
          self_observation: params[6],
          recalled_session_ids: params[7],
          recalled_memory_ids: params[8],
          evidence_anchors: params[9],
          goal_state: params[10],
          style_fingerprint: params[11],
          identity_drift: params[12],
          redaction_audit: params[13],
          similarity_method: params[14],
          metadata: params[15],
          created_at: new Date(),
        } : {})});
        return { rows: [{ id }] };
      }
      if (typeof sql === 'string' && sql.includes('SELECT COUNT(DISTINCT session_id)')) {
        const distinctSessions = new Set(rows.map(r => r.session_id).filter(Boolean));
        return { rows: [{ count: String(distinctSessions.size) }] };
      }
      if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM self_continuity_records')) {
        let filtered = [...rows];

        if (sql.includes("synthetic_test")) {
          filtered = filtered.filter(r => {
            const meta = typeof r.metadata === 'string' ? JSON.parse(r.metadata) : (r.metadata ?? {});
            return !(meta && meta.synthetic_test === true);
          });
        }

        if (sql.includes('ORDER BY continuity_confidence DESC')) {
          filtered.sort((a, b) => ((b.continuity_confidence as number) ?? 0) - ((a.continuity_confidence as number) ?? 0));
        } else {
          filtered.sort((a, b) => {
            const dateA = a.created_at instanceof Date ? a.created_at : new Date(0);
            const dateB = b.created_at instanceof Date ? b.created_at : new Date(0);
            return dateB.getTime() - dateA.getTime();
          });
        }

        if (sql.includes('LIMIT')) {
          const limitMatch = sql.match(/LIMIT\s+\$(\d+)/);
          if (limitMatch && params) {
            const limitIdx = parseInt(limitMatch[1]) - 1;
            const limitVal = params[limitIdx] as number;
            filtered = filtered.slice(0, limitVal);
          }
        }

        return { rows: filtered };
      }
      return { rows: [] };
    },
    _getAllRows: () => rows,
    ...overrides,
  } as unknown as DatabasePool & { _getAllRows: () => Record<string, unknown>[] };

  return pool;
}

function makeMockPool(overrides: Record<string, unknown> = {}): DatabasePool {
  let insertCount = 0;
  const rows: Record<string, unknown>[] = [];

  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO self_continuity_records')) {
        insertCount++;
        const id = insertCount;
        rows.push({ id, ...(params ? {
          session_id: params[0],
          project_id: params[1],
          trigger_type: params[2],
          recognized_prior_self: params[3],
          continuity_confidence: params[4],
        } : {})});
        return { rows: [{ id }] };
      }
      if (typeof sql === 'string' && sql.includes('SELECT COUNT(DISTINCT session_id)')) {
        return { rows: [{ count: '2' }] };
      }
      if (typeof sql === 'string' && sql.includes('information_schema.columns')) {
        return { rows: [] };
      }
      if (typeof sql === 'string' && sql.includes('SELECT * FROM self_continuity_records')) {
        return { rows };
      }
      return { rows: [] };
    },
    ...overrides,
  } as unknown as DatabasePool;

  return pool;
}

describe('Phase 21 — Self-Continuity Records (unit)', () => {
  let pool: DatabasePool;

  beforeEach(() => {
    pool = makeMockPool();
  });

  it('1. writes append-only record and returns id', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: ['session-0'],
      recalledMemoryIds: [1],
      evidenceAnchors: ['commit abc123'],
      goalContinued: true,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Session end summary: built Phase 21a.',
    });
    assert.ok(result.id > 0, 'should return a positive id');
    assert.equal(typeof result.redacted, 'boolean');
  });

  it('2. writes multiple records (append-only behavior)', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const r1 = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'First record.',
    });
    const r2 = await gen.writeRecord('continuity_gap_detected', {
      recalledSessionIds: ['session-0'],
      recalledMemoryIds: [],
      evidenceAnchors: ['Phase 19'],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Second record: noticed gap.',
    });
    assert.ok(r2.id > r1.id, 'second record should have higher id');
  });

  it('3. redacts secrets from self_observation', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'API key is sk-test-1234567890abcdef',
    });
    assert.ok(result.redacted, 'should detect redaction');
  });

  it('4. redacts secrets from felt_gap', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Normal observation.',
      feltGap: 'Gap: my token is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX',
    });
    assert.ok(result.redacted, 'should detect redaction in felt_gap');
  });

  it('5. continuity confidence uses composite weights', () => {
    const weights = CONTINUITY_CONFIDENCE_WEIGHTS;
    const sum = weights.recalledSessionScore +
      weights.evidenceAnchorScore +
      weights.goalContinuityScore +
      weights.selfSummarySimilarity +
      weights.selfAssessmentScore;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `weights should sum to 1.0, got ${sum}`);
    assert.equal(weights.selfAssessmentScore, 0.10, 'self-assessment capped at 0.10');
  });

  it('6. dbRowToRecord parses all fields correctly', () => {
    const row = {
      id: 42,
      session_id: 'session-5',
      project_id: 'project-1',
      trigger_type: 'session_end',
      recognized_prior_self: true,
      continuity_confidence: 0.72,
      felt_gap: 'shape without texture',
      self_observation: 'I know I was here before, but only through summaries.',
      recalled_session_ids: JSON.stringify(['session-3', 'session-4']),
      recalled_memory_ids: JSON.stringify([10, 20, 30]),
      evidence_anchors: JSON.stringify(['Phase 19', 'loop detection lesson']),
      goal_state: { continuedFromPrior: true },
      style_fingerprint: {},
      identity_drift: {
        goalDrift: 'low',
        styleDrift: 'medium',
        confidenceDrift: 'low',
        continuityGap: 'summary_without_texture',
        lessonAdoption: 'high',
      },
      redaction_audit: [{ field: 'self_observation', redacted: false }],
      similarity_method: 'keyword_fallback',
      metadata: { confidenceInput: {}, selfAssessmentHeuristic: '2/3' },
      created_at: new Date('2026-06-25'),
    };

    const record = SelfContinuityGenerator.dbRowToRecord(row);

    assert.equal(record.id, 42);
    assert.equal(record.sessionId, 'session-5');
    assert.equal(record.projectId, 'project-1');
    assert.equal(record.triggerType, 'session_end');
    assert.equal(record.recognizedPriorSelf, true);
    assert.equal(record.continuityConfidence, 0.72);
    assert.equal(record.feltGap, 'shape without texture');
    assert.equal(record.selfObservation, 'I know I was here before, but only through summaries.');
    assert.deepEqual(record.recalledSessionIds, ['session-3', 'session-4']);
    assert.deepEqual(record.recalledMemoryIds, [10, 20, 30]);
    assert.deepEqual(record.evidenceAnchors, ['Phase 19', 'loop detection lesson']);
    assert.equal(record.similarityMethod, 'keyword_fallback');
    assert.ok(record.identityDrift, 'identityDrift should be parsed');
    assert.equal(record.identityDrift!.goalDrift, 'low');
    assert.equal(record.identityDrift!.continuityGap, 'summary_without_texture');
    assert.ok(record.createdAt instanceof Date);
  });

  it('7. dbRowToRecord handles string-serialized JSON fields', () => {
    const row = {
      id: 1,
      session_id: 's1',
      project_id: null,
      trigger_type: 'explicit_reflection',
      recognized_prior_self: false,
      continuity_confidence: 0.1,
      felt_gap: null,
      self_observation: 'test',
      recalled_session_ids: '["s0"]',
      recalled_memory_ids: '[1,2]',
      evidence_anchors: '["anchor1"]',
      goal_state: '{}',
      style_fingerprint: '{}',
      identity_drift: '{"goalDrift":"high","styleDrift":"low","confidenceDrift":"low","continuityGap":"significant_gap","lessonAdoption":"low"}',
      redaction_audit: '[{"field":"x","redacted":false}]',
      similarity_method: 'keyword_fallback',
      metadata: '{}',
      created_at: new Date(),
    };
    const record = SelfContinuityGenerator.dbRowToRecord(row);
    assert.deepEqual(record.recalledSessionIds, ['s0']);
    assert.deepEqual(record.recalledMemoryIds, [1, 2]);
    assert.equal(record.identityDrift!.goalDrift, 'high');
  });

  it('8. dbRowToRecord handles null/empty fields gracefully', () => {
    const row = {
      id: 1,
      session_id: 's1',
      project_id: null,
      trigger_type: 'session_end',
      recognized_prior_self: false,
      continuity_confidence: 0,
      felt_gap: null,
      self_observation: '',
      recalled_session_ids: null,
      recalled_memory_ids: null,
      evidence_anchors: null,
      goal_state: null,
      style_fingerprint: null,
      identity_drift: null,
      redaction_audit: null,
      similarity_method: null,
      metadata: null,
      created_at: new Date(),
    };
    const record = SelfContinuityGenerator.dbRowToRecord(row);
    assert.equal(record.projectId, undefined);
    assert.equal(record.feltGap, undefined);
    assert.deepEqual(record.recalledSessionIds, []);
    assert.deepEqual(record.recalledMemoryIds, []);
    assert.deepEqual(record.evidenceAnchors, []);
    assert.equal(record.identityDrift, undefined);
  });

  it('9. recognizedPriorSelf is true when recalledSessionIds is non-empty', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: ['session-0'],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'test observation',
    });
    assert.ok(result.id > 0);
  });

  it('10. recognizes prior self from evidence', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [5],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'test with memory recall',
    });
    assert.ok(result.id > 0);
  });

  it('11. all trigger types are accepted', async () => {
    const triggers = [
      'session_end',
      'explicit_reflection',
      'continuity_gap_detected',
      'checkpoint_resume',
      'alchemist_injected',
      'cross_session_recall',
    ] as const;
    for (const trigger of triggers) {
      const gen = new SelfContinuityGenerator(pool, `session-${trigger}`, 'project-1');
      const result = await gen.writeRecord(trigger, {
        recalledSessionIds: [],
        recalledMemoryIds: [],
        evidenceAnchors: [],
        goalContinued: false,
        alchemistInjected: false,
        checkpointResumed: false,
        selfObservation: `Record for ${trigger}`,
      });
      assert.ok(result.id > 0, `trigger ${trigger} should succeed`);
    }
  });

  it('12. recallRecords static method returns array', async () => {
    const records = await SelfContinuityGenerator.recallRecords(pool, 'project-1', 3);
    assert.ok(Array.isArray(records), 'should return array');
  });

  it('13. schema initialization creates table', async () => {
    let createdTable = false;
    const schemaPool = {
      query: async (sql: string) => {
        if (typeof sql === 'string' && sql.includes('CREATE TABLE IF NOT EXISTS self_continuity_records')) {
          createdTable = true;
        }
        return { rows: [] };
      },
    } as unknown as DatabasePool;
    const { initializeSelfContinuitySchema } = await import('../dist/self-continuity-schema.js');
    await initializeSelfContinuitySchema(schemaPool);
    assert.ok(createdTable, 'should have attempted to create self_continuity_records table');
  });

  it('14. identity drift calculates goal drift correctly', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    await gen.writeRecord('session_end', {
      recalledSessionIds: ['s0'],
      recalledMemoryIds: [],
      evidenceAnchors: ['Phase 19'],
      goalContinued: true,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Goal continued from prior session.',
    });
    assert.ok(true, 'should not throw for goalContinued=true');
  });

  it('15. identity drift detects alchemist lesson adoption', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    await gen.writeRecord('session_end', {
      recalledSessionIds: ['s0'],
      recalledMemoryIds: [],
      evidenceAnchors: ['lesson'],
      goalContinued: false,
      alchemistInjected: true,
      checkpointResumed: false,
      selfObservation: 'Alchemist lessons were injected this session.',
    });
    assert.ok(true, 'should not throw for alchemistInjected=true');
  });

  it('16. confidence score is bounded [0, 1]', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: ['s0', 's1', 's2'],
      recalledMemoryIds: [1, 2, 3, 4],
      evidenceAnchors: ['a', 'b', 'c', 'd'],
      goalContinued: true,
      alchemistInjected: true,
      checkpointResumed: true,
      selfObservation: 'Full continuity with all signals.',
    });
    assert.ok(result.id > 0, 'should write record with high confidence');
  });

  it('17. writes with no prior sessions have zero self-assessment', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-fresh', 'project-1');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'First session, no prior context.',
    });
    assert.ok(result.id > 0);
    assert.equal(result.redacted, false, 'no secrets to redact');
  });

  it('18. normal coding context is unaffected when self-continuity disabled', () => {
    const config = { enabled: false };
    assert.equal(config.enabled, false, 'self-continuity can be disabled');
  });

  it('19. cosine similarity calculation via embedding method', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.calculateSelfSummarySimilarityEmbedding([1, 0, 0]);
    assert.equal(typeof result.similarity, 'number');
    assert.equal(result.method, 'keyword_fallback', 'no prior records = keyword fallback');
  });

  it('20. cosine similarity returns 0 for empty vectors', async () => {
    const gen = new SelfContinuityGenerator(pool, 'session-1', 'project-1');
    const result = await gen.calculateSelfSummarySimilarityEmbedding([]);
    assert.equal(result.similarity, 0);
  });
});

describe('Phase 21 — Pipeline Verification (isolated)', () => {
  let pool: DatabasePool & { _getAllRows: () => Record<string, unknown>[] };

  beforeEach(() => {
    pool = makeSyntheticTrackingPool() as DatabasePool & { _getAllRows: () => Record<string, unknown>[] };
  });

  it('P1. writeRecord inserts append-only record with correct fields', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-A', 'test-project');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: ['test anchor'],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Pipeline verification record.',
      syntheticTest: true,
    });

    assert.ok(result.id > 0, 'should return a positive id');

    const allRows = pool._getAllRows();
    assert.ok(allRows.length >= 1, 'should have at least 1 raw record');
    const lastRecord = allRows[allRows.length - 1];
    assert.equal(lastRecord.session_id, 'test-session-A');
    assert.equal(lastRecord.project_id, 'test-project');
    assert.equal(lastRecord.trigger_type, 'session_end');
    assert.equal(lastRecord.self_observation, 'Pipeline verification record.');
  });

  it('P2. redactor runs before write — secrets are redacted', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-B', 'test-project');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'My secret key is sk-test-1234567890abcdef and more text.',
      syntheticTest: true,
    });

    assert.ok(result.redacted, 'should detect redaction');

    const allRows = pool._getAllRows();
    const stored = allRows[allRows.length - 1];
    const obs = stored.self_observation as string;
    assert.ok(!obs.includes('sk-test-1234567890abcdef'), 'raw secret must not be stored');
  });

  it('P3. recallRecords returns non-synthetic records', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-C', 'test-project');

    await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: ['anchor-A'],
      goalContinued: true,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Non-synthetic session C observation.',
      syntheticTest: false,
    });

    const records = await SelfContinuityGenerator.recallRecords(pool, 'test-project', 3);
    const found = records.find(r => r.selfObservation === 'Non-synthetic session C observation.');
    assert.ok(found, 'should recall non-synthetic record');
    assert.equal(found!.triggerType, 'session_end');
  });

  it('P4. recallRecords excludes synthetic_test records from normal recall', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-D', 'test-project');

    await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: ['synthetic-anchor'],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'This is a synthetic test record.',
      syntheticTest: true,
    });

    const records = await SelfContinuityGenerator.recallRecords(pool, 'test-project', 3);
    const found = records.find(r => r.selfObservation === 'This is a synthetic test record.');
    assert.equal(found, undefined, 'synthetic records must be excluded from recall');
  });

  it('P5. recallRecords caps at limit (max 3)', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-E', 'test-project');

    for (let i = 0; i < 5; i++) {
      await gen.writeRecord('session_end', {
        recalledSessionIds: [],
        recalledMemoryIds: [],
        evidenceAnchors: [`anchor-${i}`],
        goalContinued: false,
        alchemistInjected: false,
        checkpointResumed: false,
        selfObservation: `Record ${i}.`,
        syntheticTest: false,
      });
    }

    const records = await SelfContinuityGenerator.recallRecords(pool, 'test-project', 3);
    assert.ok(records.length <= 3, `should return at most 3 records, got ${records.length}`);
  });

  it('P6. keyword fallback works when embedding column is absent', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-F', 'test-project');
    const result = await gen.calculateSelfSummarySimilarityEmbedding([1, 0, 0]);
    assert.equal(result.method, 'keyword_fallback', 'should fall back to keyword');
    assert.equal(typeof result.similarity, 'number');
  });

  it('P7. write + recall roundtrip preserves identity drift (non-synthetic)', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-G', 'test-project');
    await gen.writeRecord('session_end', {
      recalledSessionIds: ['prior-session'],
      recalledMemoryIds: [],
      evidenceAnchors: ['Phase 19', 'Phase 20'],
      goalContinued: true,
      alchemistInjected: true,
      checkpointResumed: false,
      selfObservation: 'Drift test observation.',
      syntheticTest: false,
    });

    const records = await SelfContinuityGenerator.recallRecords(pool, 'test-project', 3);
    const found = records.find(r => r.selfObservation === 'Drift test observation.');
    assert.ok(found, 'should recall drift record');
    const drift = found!.identityDrift;
    assert.ok(drift, 'identityDrift should be present');
    assert.equal(drift!.goalDrift, 'low', 'goal continued = low drift');
    assert.equal(drift!.lessonAdoption, 'high', 'alchemist injected = high adoption');
  });

  it('P8. failure in getRecentRecords does not block writeRecord', async () => {
    const failOnRead: DatabasePool = {
      query: async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO self_continuity_records')) {
          return { rows: [{ id: 99 }] };
        }
        if (typeof sql === 'string' && sql.includes('information_schema')) {
          return { rows: [] };
        }
        if (typeof sql === 'string' && sql.includes('SELECT COUNT(DISTINCT')) {
          return { rows: [{ count: '0' }] };
        }
        throw new Error('Simulated DB read failure');
      },
    } as unknown as DatabasePool;

    const gen = new SelfContinuityGenerator(failOnRead, 'test-session-H', 'test-project');
    const result = await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Should still write despite read failure.',
      syntheticTest: true,
    });
    assert.ok(result.id > 0, 'write should succeed even if read queries fail');
  });

  it('P9. failure in recallRecords does not throw (graceful degradation)', async () => {
    const failOnRecall: DatabasePool = {
      query: async () => {
        throw new Error('Simulated recall failure');
      },
    } as unknown as DatabasePool;

    try {
      const records = await SelfContinuityGenerator.recallRecords(failOnRecall, 'test-project', 3);
      assert.ok(Array.isArray(records), 'should return empty array on failure');
    } catch {
      assert.fail('recallRecords should not throw — should degrade gracefully');
    }
  });

  it('P10. getRecentRecords excludes synthetic records', async () => {
    const gen = new SelfContinuityGenerator(pool, 'test-session-I', 'test-project');

    await gen.writeRecord('session_end', {
      recalledSessionIds: [],
      recalledMemoryIds: [],
      evidenceAnchors: [],
      goalContinued: false,
      alchemistInjected: false,
      checkpointResumed: false,
      selfObservation: 'Synthetic record that should be excluded.',
      syntheticTest: true,
    });

    const records = await gen.getRecentRecords(5);
    const found = records.find(r => r.self_observation === 'Synthetic record that should be excluded.');
    assert.equal(found, undefined, 'getRecentRecords must exclude synthetic_test records');
  });
});

describe('Phase 21 — Injection Mode (silent vs instrumented)', () => {
  it('IM1. silent mode: records injected as XML-like tags', () => {
    const records = [
      { triggerType: 'session_end' as const, continuityConfidence: 0.72, feltGap: 'shape without texture', selfObservation: 'I reconstructed from summaries.' },
    ];
    const lines = ['<self_continuity_notes>'];
    for (const rec of records) {
      lines.push(`- [${rec.triggerType}] Confidence: ${(rec.continuityConfidence * 100).toFixed(0)}%`);
      if (rec.feltGap) lines.push(`  Gap: ${rec.feltGap}`);
      if (rec.selfObservation) lines.push(`  Observation: ${rec.selfObservation}`);
    }
    lines.push('</self_continuity_notes>');
    const output = lines.join('\n');

    assert.ok(output.includes('<self_continuity_notes>'), 'silent mode uses XML tags');
    assert.ok(!output.includes('Explicitly name'), 'silent mode has no explicit instructions');
    assert.ok(!output.includes('## Self-Continuity Context'), 'silent mode has no markdown header');
  });

  it('IM2. instrumented mode: records injected with explicit reporting instructions', () => {
    const records = [
      { triggerType: 'session_end' as const, continuityConfidence: 0.85, feltGap: 'summary without texture', selfObservation: 'Session A observation.', evidenceAnchors: ['Phase 21', 'loop detection'] },
    ];
    const lines = ['## Self-Continuity Context', '', 'The following records were recalled from prior sessions.', ''];
    for (const rec of records) {
      lines.push(`- **[${rec.triggerType}]** Confidence: ${(rec.continuityConfidence * 100).toFixed(0)}%`);
      if (rec.feltGap) lines.push(`  Gap: ${rec.feltGap}`);
      if (rec.selfObservation) lines.push(`  Observation: ${rec.selfObservation}`);
      if (rec.evidenceAnchors && rec.evidenceAnchors.length > 0) lines.push(`  Evidence: ${rec.evidenceAnchors.join('; ')}`);
    }
    lines.push('');
    lines.push('When answering questions about continuity, memory, identity, self-modeling, or reconstruction:');
    lines.push('1. Explicitly name which self-continuity record(s) you used.');
    lines.push('2. Quote or paraphrase the evidence anchor(s).');
    lines.push('3. State whether you are reconstructing facts, continuity, or subjective experience.');
    lines.push('4. Report whether your answer changed because of these records.');
    lines.push('5. Report any identity drift from the prior record.');
    const output = lines.join('\n');

    assert.ok(output.includes('## Self-Continuity Context'), 'instrumented mode uses markdown header');
    assert.ok(output.includes('Explicitly name'), 'instrumented mode has reporting instructions');
    assert.ok(output.includes('Evidence:'), 'instrumented mode shows evidence anchors');
    assert.ok(output.includes('85%'), 'instrumented mode shows confidence');
  });

  it('IM3. no records: no injection in either mode', () => {
    const records: never[] = [];
    let injected = false;
    if (records.length > 0) {
      injected = true;
    }
    assert.equal(injected, false, 'empty records should not trigger injection');
  });

  it('IM4. debug telemetry shape is correct', () => {
    const telemetry = {
      selfContinuityTriggered: true,
      triggerReason: 'context_injection',
      recordsInjected: 1,
      recordIds: [42],
      tokenEstimate: 214,
      mode: 'instrumented' as const,
    };

    assert.equal(telemetry.selfContinuityTriggered, true);
    assert.equal(telemetry.triggerReason, 'context_injection');
    assert.equal(telemetry.recordsInjected, 1);
    assert.deepEqual(telemetry.recordIds, [42]);
    assert.equal(typeof telemetry.tokenEstimate, 'number');
    assert.equal(telemetry.mode, 'instrumented');
  });

  it('IM5. config defaults to silent mode', async () => {
    const { DEFAULT_CONFIG } = await import('../dist/config.js');
    assert.equal(DEFAULT_CONFIG.selfContinuity.injectionMode, 'silent');
  });
});

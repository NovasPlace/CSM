import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { BeliefPromotionConfig, MemorySaveOptions, Memory } from '../src/types.js';

const TEST_DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const testPromotionConfig: BeliefPromotionConfig = {
  enabled: true,
  dryRunByDefault: true,
  minConfidence: 0.7,
  minReinforcement: 3,
  minEvidenceRefs: 2,
  minSessions: 1,
  maxPromotePerRun: 10,
  relaxed: false,
};

function makePromotionMemoryManager(pool: pg.Pool) {
  return {
    async saveMemory(options: MemorySaveOptions): Promise<Memory> {
      const result = await pool.query(
        `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         RETURNING *`,
        [
          options.type,
          options.content,
          options.importance ?? 0.5,
          options.confidence ?? 1.0,
          options.source ?? 'auto',
          options.tags ?? [],
          JSON.stringify(options.metadata ?? {}),
        ],
      );
      const row = result.rows[0] as Record<string, unknown>;
      return {
        id: Number(row.id),
        memoryType: String(row.memory_type),
        content: String(row.content),
        importance: Number(row.importance),
        confidence: Number(row.confidence),
        createdAt: new Date(String(row.created_at)),
        updatedAt: row.updated_at ? new Date(String(row.updated_at)) : undefined,
        source: String(row.source ?? ''),
        tags: Array.isArray(row.tags) ? row.tags as string[] : [],
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata as string) : (row.metadata as Record<string, unknown> ?? {}),
        sessionId: row.session_id as string | undefined,
        projectId: row.project_id as string | undefined,
        embedding: row.embedding as number[] | undefined,
        supersededBy: row.superseded_by as number | undefined,
        supersededAt: row.superseded_at ? new Date(String(row.superseded_at)) : undefined,
        archivedAt: row.archived_at ? new Date(String(row.archived_at)) : undefined,
      } as Memory;
    },
  };
}

function makePool() {
  return new pg.Pool({ connectionString: TEST_DB_URL });
}

async function insertTestPacket(pool: pg.Pool, overrides: Record<string, unknown> = {}) {
  const result = await pool.query(
    `INSERT INTO experience_packets (session_id, project_id, entry_type, signals, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      overrides.session_id ?? 'test-promotion-session',
      overrides.project_id ?? null,
      overrides.entry_type ?? 'tool_execution',
      JSON.stringify(overrides.signals ?? { toolName: 'bash' }),
      overrides.created_at ?? new Date().toISOString(),
    ],
  );
  return result.rows[0].id as number;
}

async function insertTestCandidate(pool: pg.Pool, overrides: Record<string, unknown> = {}) {
  const packetIds = overrides.source_packet_ids ?? [1];
  const result = await pool.query(
    `INSERT INTO memory_candidate_queue
       (candidate_type, memory_id, dedup_key, reason, confidence, event_count,
        reinforcement_count, contradicted_count, source_packet_ids, promotion_ready, status)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
     RETURNING id`,
    [
      overrides.candidate_type ?? 'candidate_preference',
      overrides.dedup_key ?? `test-dedup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      overrides.reason ?? 'Test tool succeeds reliably',
      overrides.confidence ?? 0.9,
      overrides.event_count ?? 10,
      overrides.reinforcement_count ?? 5,
      overrides.contradicted_count ?? 0,
      JSON.stringify(packetIds),
      overrides.promotion_ready ?? true,
    ],
  );
  return result.rows[0].id as number;
}

async function cleanup(pool: pg.Pool, packetIds: number[], candidateIds: number[]) {
  for (const id of candidateIds) {
    await pool.query('DELETE FROM memory_candidate_queue WHERE id = $1', [id]).catch(() => {});
  }
  for (const id of packetIds) {
    await pool.query('DELETE FROM experience_packets WHERE id = $1', [id]).catch(() => {});
  }
  await pool.query("DELETE FROM memories WHERE metadata->>'promotion_source' = 'belief_promotion_engine' AND content LIKE '[Promoted from candidate%'").catch(() => {});
}

/**
 * Purge all test-pattern candidates and their packets before each test.
 *
 * Without this, failed test runs leave pending candidates in the DB (cleanup
 * at the end of each it() never runs when an assertion throws). The engine
 * loads ALL pending candidates ordered by confidence/reinforcement DESC, and
 * maxPromotePerRun=10 breaks the loop early — so a leftover 0.9/5 candidate
 * shadows the test's 0.3/2 candidate, causing "decision should exist" to fail.
 */
async function cleanupTestArtifacts(pool: pg.Pool) {
  await pool.query(
    `DELETE FROM memory_candidate_queue
     WHERE dedup_key LIKE 'relaxed-test-%'
        OR dedup_key LIKE 'low-conf-default-%'
        OR dedup_key LIKE 'low-conf-test-%'
        OR dedup_key LIKE 'test-dedup-%'
        OR dedup_key LIKE 'checks-test-%'
        OR dedup_key LIKE 'live-test-%'`,
  ).catch(() => {});
  await pool.query(
    "DELETE FROM experience_packets WHERE session_id IN ('test-promotion-session', 'relaxed-sess-1', 'relaxed-sess-2', 'live-promote-sess')",
  ).catch(() => {});
  await pool.query(
    "DELETE FROM memories WHERE metadata->>'promotion_source' = 'belief_promotion_engine' AND content LIKE '[Promoted from candidate%'",
  ).catch(() => {});
}

describe('BeliefPromotionEngine', () => {
  let pool: pg.Pool;

  before(() => { pool = makePool(); });
  beforeEach(async () => { await cleanupTestArtifacts(pool); });
  after(async () => { await pool.end(); });

  it('skips candidates below minConfidence', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.3,
      reinforcement_count: 5,
      source_packet_ids: [packetId],
      dedup_key: `low-conf-test-${Date.now()}`,
      reason: `Low confidence candidate for testing ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: true, minConfidence: 0.7 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist for inserted candidate');
    assert.equal(decision.action, 'skip_low_confidence');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('skips candidates below minReinforcement', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.9,
      reinforcement_count: 1,
      source_packet_ids: [packetId],
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: true, minConfidence: 0.7, minReinforcement: 3 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_low_reinforcement');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('skips candidates with contradictedCount > 0 (needs_review)', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.9,
      reinforcement_count: 5,
      contradicted_count: 1,
      source_packet_ids: [packetId],
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: true, minConfidence: 0.7, minReinforcement: 3 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'needs_review');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('skips candidates with insufficient evidence refs', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.9,
      reinforcement_count: 5,
      source_packet_ids: [packetId],
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: true, minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 3 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_low_evidence');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('dry-run reports what would be promoted without writing', async () => {
    const packetId1 = await insertTestPacket(pool, { session_id: 'test-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'test-sess-2' });
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.9,
      reinforcement_count: 5,
      source_packet_ids: [packetId1, packetId2],
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: true, minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2, minSessions: 1 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'promote');
    assert.equal(report.promotedMemoryIds.length, 0, 'no memories written in dry-run');

    const memCheck = await pool.query("SELECT COUNT(*) as cnt FROM memories WHERE metadata->>'promotion_source' = 'belief_promotion_engine' AND content LIKE '[Promoted fr%'");
    const cnt = typeof memCheck.rows[0].cnt === 'string' ? parseInt(memCheck.rows[0].cnt) : memCheck.rows[0].cnt;
    assert.equal(cnt, 0, 'no memories should exist from dry-run');

    await cleanup(pool, [packetId1, packetId2], [candidateId]);
  });

  it('live mode creates memory with provenance metadata', async () => {
    const packetId1 = await insertTestPacket(pool, { session_id: 'live-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'live-sess-2' });
    const uniqueReason = `Live promotion test candidate ${Date.now()} ${Math.random().toString(36).slice(2)}`;
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.95,
      reinforcement_count: 7,
      source_packet_ids: [packetId1, packetId2],
      dedup_key: `live-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      reason: uniqueReason,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: false, minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2, minSessions: 1 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'promote');
    assert.ok(report.promotedMemoryIds.length >= 1, 'at least one memory promoted');

    // Find the memory created from our candidate by checking metadata
    let memId: number | null = null;
    for (const id of report.promotedMemoryIds) {
      const memResult = await pool.query('SELECT metadata FROM memories WHERE id = $1', [id]);
      if (memResult.rows.length > 0) {
        const meta = typeof memResult.rows[0].metadata === 'string' ? JSON.parse(memResult.rows[0].metadata) : memResult.rows[0].metadata;
        if (meta.candidate_id === candidateId) {
          memId = id;
          break;
        }
      }
    }
    assert.ok(memId, 'memory with matching candidate_id found');
    const memResult = await pool.query('SELECT * FROM memories WHERE id = $1', [memId!]);
    assert.equal(memResult.rows.length, 1, 'memory exists');
    const mem = memResult.rows[0];
    assert.equal(mem.source, 'auto');
    assert.ok(mem.content.includes(`candidate ${candidateId}`), 'content references candidate');

    const meta = typeof mem.metadata === 'string' ? JSON.parse(mem.metadata) : mem.metadata;
    assert.equal(meta.candidate_id, candidateId);
    assert.equal(meta.candidate_type, 'candidate_preference');
    assert.ok(Array.isArray(meta.source_packet_ids));
    assert.ok(meta.promoted_at);

    const candResult = await pool.query('SELECT status FROM memory_candidate_queue WHERE id = $1', [candidateId]);
    assert.equal(candResult.rows[0].status, 'applied');

    await cleanup(pool, [packetId1, packetId2], []);
  });

  it('low-confidence candidates do not promote in default mode', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.3,
      reinforcement_count: 5,
      source_packet_ids: [packetId],
      dedup_key: `low-conf-default-${Date.now()}`,
      reason: `Low confidence default mode test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    // Default mode: minConfidence=0.7, should skip
    const report = await engine.promote({ dryRun: true });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_low_confidence', 'should skip low confidence in default mode');
    assert.equal(report.relaxed, false, 'relaxed should be false by default');
    assert.equal(report.thresholdProfile.minConfidence, 0.7, 'default threshold should be 0.7');

    // Verify thresholdChecks show the failure
    assert.equal(decision.thresholdChecks.confidence.passed, false);
    assert.equal(decision.thresholdChecks.confidence.actual, 0.3);
    assert.equal(decision.thresholdChecks.confidence.required, 0.7);

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('relaxed mode allows low-confidence candidates to promote', async () => {
    const packetId1 = await insertTestPacket(pool, { session_id: 'relaxed-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'relaxed-sess-2' });
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.3,
      reinforcement_count: 2,
      source_packet_ids: [packetId1, packetId2],
      dedup_key: `relaxed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      reason: `Relaxed mode test ${Date.now()} ${Math.random().toString(36).slice(2)}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    // Relaxed mode: minConfidence=0.3, should promote.
    // maxPromote=1000 ensures the test candidate (low confidence, sits at the
    // tail of the ordered list) is reached despite pre-existing pending
    // candidates in the live DB. This is dryRun, so no side effects.
    const report = await engine.promote({ dryRun: true, relaxed: true, maxPromote: 1000 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'promote', 'should promote in relaxed mode');
    assert.equal(report.relaxed, true, 'relaxed should be true');
    assert.equal(report.thresholdProfile.minConfidence, 0.3, 'relaxed threshold should be 0.3');
    assert.equal(report.thresholdProfile.minReinforcement, 1, 'relaxed reinforcement should be 1');
    assert.equal(report.thresholdProfile.minEvidenceRefs, 1, 'relaxed evidence should be 1');

    await cleanup(pool, [packetId1, packetId2], [candidateId]);
  });

  it('report includes thresholdChecks for every decision', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.5,
      reinforcement_count: 2,
      source_packet_ids: [packetId],
      dedup_key: `checks-test-${Date.now()}`,
      reason: `Threshold checks test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const report = await engine.promote({ dryRun: true, minConfidence: 0.7 });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.ok(decision.thresholdChecks, 'thresholdChecks should exist');
    assert.ok(typeof decision.thresholdChecks.confidence.passed === 'boolean', 'confidence.passed should be boolean');
    assert.ok(typeof decision.thresholdChecks.confidence.actual === 'number', 'confidence.actual should be number');
    assert.ok(typeof decision.thresholdChecks.confidence.required === 'number', 'confidence.required should be number');
    assert.ok(typeof decision.thresholdChecks.reinforcement.passed === 'boolean', 'reinforcement.passed should be boolean');
    assert.ok(typeof decision.thresholdChecks.evidence.passed === 'boolean', 'evidence.passed should be boolean');
    assert.ok(typeof decision.thresholdChecks.sessions.passed === 'boolean', 'sessions.passed should be boolean');
    assert.ok(typeof decision.thresholdChecks.contradicted.passed === 'boolean', 'contradicted.passed should be boolean');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('skip_dedup_match marks candidate applied (not left pending forever)', async () => {
    // Candidate crosses all thresholds but matches an existing memory's dedup_key.
    // Re-evaluation would never produce a different result, so the candidate
    // should be marked applied in the queue to stop shadowing pending candidates.
    // (Closure Criterion 6: structural dedup_key idempotency.)
    const packetId1 = await insertTestPacket(pool, { session_id: 'dedup-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'dedup-sess-2' });
    const dedupKey = `dedup-applied-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // First: insert a memory with this dedup_key so the candidate will match it
    await pool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [
        'preference',
        'Existing memory with matching dedup_key',
        0.6,
        0.8,
        'manual',
        ['test-fixture'],
        JSON.stringify({ promotion_source: 'manual', dedup_key: dedupKey }),
      ],
    );

    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.9,
      reinforcement_count: 5,
      source_packet_ids: [packetId1, packetId2],
      dedup_key: dedupKey,
      reason: `Dedup-applied test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    // Live (non-dry-run) promotion: candidate should skip due to dedup match
    const report = await engine.promote({
      dryRun: false,
      minConfidence: 0.7,
      minReinforcement: 3,
      minEvidenceRefs: 2,
      minSessions: 1,
    });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_dedup_match', 'candidate should match existing memory');
    assert.ok(decision.dedupMatchId, 'dedupMatchId should be set');
    assert.equal(report.promoted, 0, 'no memory should be promoted for dedup match');

    // The candidate should be marked 'applied' in the DB so it doesn't keep reappearing
    const candResult = await pool.query('SELECT status FROM memory_candidate_queue WHERE id = $1', [candidateId]);
    assert.equal(candResult.rows[0].status, 'applied', 'dedup-matched candidate should be marked applied (not left pending)');

    // Second run: candidate should not appear at all since it is now applied
    const report2 = await engine.promote({
      dryRun: false,
      minConfidence: 0.7,
      minReinforcement: 3,
      minEvidenceRefs: 2,
      minSessions: 1,
    });
    const stillAppears = report2.decisions.find(d => d.candidateId === candidateId);
    assert.equal(stillAppears, undefined, 'applied dedup candidate should not appear in subsequent runs');

    await cleanup(pool, [packetId1, packetId2], [candidateId]);
    // Clean up the manually inserted memory
    await pool.query("DELETE FROM memories WHERE metadata->>'dedup_key' = $1", [dedupKey]).catch(() => {});
  });

  it('dry-run skip_dedup_match does NOT mark candidate applied (no writes in dry-run)', async () => {
    const packetId1 = await insertTestPacket(pool, { session_id: 'dedup-dry-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'dedup-dry-sess-2' });
    const dedupKey = `dedup-dry-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Insert matching memory
    await pool.query(
      `INSERT INTO memories (memory_type, content, importance, confidence, source, tags, metadata, session_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [
        'preference',
        'Existing memory for dry-run dedup test',
        0.6,
        0.8,
        'manual',
        ['test-fixture'],
        JSON.stringify({ promotion_source: 'manual', dedup_key: dedupKey }),
      ],
    );

    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.9,
      reinforcement_count: 5,
      source_packet_ids: [packetId1, packetId2],
      dedup_key: dedupKey,
      reason: `Dedup dry-run test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    // Dry-run: should skip but NOT mutate candidate status
    const report = await engine.promote({
      dryRun: true,
      minConfidence: 0.7,
      minReinforcement: 3,
      minEvidenceRefs: 2,
      minSessions: 1,
    });

    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_dedup_match', 'should detect dedup match even in dry-run');

    const candResult = await pool.query('SELECT status FROM memory_candidate_queue WHERE id = $1', [candidateId]);
    assert.equal(candResult.rows[0].status, 'pending', 'dry-run must not mutate candidate status');

    await cleanup(pool, [packetId1, packetId2], [candidateId]);
    await pool.query("DELETE FROM memories WHERE metadata->>'dedup_key' = $1", [dedupKey]).catch(() => {});
  });

  it('low-confidence skips do NOT mark candidate applied (may cross threshold later)', async () => {
    // Low-evidence candidates stay pending so they can be re-evaluated when
    // reinforcement accumulates. Only skip_dedup_match is terminal.
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.3,
      reinforcement_count: 2,
      source_packet_ids: [packetId],
      dedup_key: `low-conf-pending-${Date.now()}`,
      reason: `Low-confidence pending test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    const report = await engine.promote({ dryRun: false, minConfidence: 0.7 });
    const decision = report.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_low_confidence');

    // Low-confidence skip must NOT mark applied — candidate stays pending
    const candResult = await pool.query('SELECT status FROM memory_candidate_queue WHERE id = $1', [candidateId]);
    assert.equal(candResult.rows[0].status, 'pending', 'low-confidence skip should leave candidate pending');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('live promotion is idempotent (re-running does not re-promote applied candidates)', async () => {
    const packetId1 = await insertTestPacket(pool, { session_id: 'test-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'test-sess-2' });
    const dedupKey = `live-test-idempotent-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.95,
      reinforcement_count: 7,
      source_packet_ids: [packetId1, packetId2],
      dedup_key: dedupKey,
      reason: `Idempotent promotion test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    // First run: promote
    const report1 = await engine.promote({ dryRun: false, minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2, minSessions: 1 });
    const decision1 = report1.decisions.find(d => d.candidateId === candidateId);
    assert.ok(decision1, 'first run decision should exist');
    assert.equal(decision1.action, 'promote');
    const promotedCount1 = report1.promotedMemoryIds.length;
    assert.ok(promotedCount1 >= 1, 'first run should promote at least one');

    // Second run: candidate should be 'applied', not re-promoted
    const report2 = await engine.promote({ dryRun: false, minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2, minSessions: 1 });
    const decision2 = report2.decisions.find(d => d.candidateId === candidateId);
    // The candidate should not appear in the second run since it's already 'applied'
    const stillPending = report2.decisions.find(d => d.candidateId === candidateId && d.action === 'promote');
    assert.equal(stillPending, undefined, 'applied candidate should not be re-promoted');

    // Verify candidate status is 'applied' in DB
    const candResult = await pool.query('SELECT status FROM memory_candidate_queue WHERE id = $1', [candidateId]);
    assert.equal(candResult.rows[0].status, 'applied', 'candidate should be applied in DB');

    await cleanup(pool, [packetId1, packetId2], []);
  });

  it('empty candidate queue returns clean empty result, not failure', async () => {
    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);

    // Clear all test artifacts to ensure clean queue (other pending candidates may exist in dev DB)
    // We just verify that the engine doesn't throw on an empty result set
    const report = await engine.promote({ dryRun: true, minConfidence: 0.99, minReinforcement: 999 });

    assert.ok(report, 'should return a report');
    assert.equal(report.promoted, 0, 'should not promote anything');
    // candidatesEvaluated may be > 0 if real candidates exist in dev DB, but no errors
    assert.ok(typeof report.candidatesEvaluated === 'number', 'candidatesEvaluated should be a number');
    assert.ok(Array.isArray(report.decisions), 'decisions should be an array');
  });
});

// ============================================================================
// Phase 4G: csm_belief_promotion_scan tool (read-only)
// ============================================================================

describe('csm_belief_promotion_scan tool', () => {
  let pool: pg.Pool;

  before(() => { pool = makePool(); });
  beforeEach(async () => { await cleanupTestArtifacts(pool); });
  after(async () => { await pool.end(); });

  it('scan tool performs no writes (no memories created)', async () => {
    const packetId1 = await insertTestPacket(pool, { session_id: 'scan-sess-1' });
    const packetId2 = await insertTestPacket(pool, { session_id: 'scan-sess-2' });
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.95,
      reinforcement_count: 7,
      source_packet_ids: [packetId1, packetId2],
      dedup_key: `scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      reason: `Scan tool test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const { beliefPromotionScanTool } = await import('../dist/belief-promotion-tool.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const tool = beliefPromotionScanTool(engine, testPromotionConfig);

    const output = await tool.execute({}) as string;

    // Verify no memories were created
    const memCheck = await pool.query(
      "SELECT COUNT(*) as cnt FROM memories WHERE metadata->>'promotion_source' = 'belief_promotion_engine' AND content LIKE '[Promoted fr%'",
    );
    const cnt = typeof memCheck.rows[0].cnt === 'string' ? parseInt(memCheck.rows[0].cnt) : memCheck.rows[0].cnt;
    assert.equal(cnt, 0, 'scan tool should not create any memories');

    // Verify candidate is still 'pending' (not promoted)
    const candResult = await pool.query('SELECT status FROM memory_candidate_queue WHERE id = $1', [candidateId]);
    assert.equal(candResult.rows[0].status, 'pending', 'scan tool should not change candidate status');

    // Verify output mentions read-only
    assert.ok(output.includes('READ-ONLY') || output.includes('read-only') || output.includes('No writes'), 'output should mention read-only');

    await cleanup(pool, [packetId1, packetId2], [candidateId]);
  });

  it('scan tool shows decisions with reasoning', async () => {
    const packetId = await insertTestPacket(pool);
    const candidateId = await insertTestCandidate(pool, {
      confidence: 0.3,
      reinforcement_count: 1,
      source_packet_ids: [packetId],
      dedup_key: `scan-low-${Date.now()}`,
      reason: `Scan low confidence test ${Date.now()}`,
    });

    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const { beliefPromotionScanTool } = await import('../dist/belief-promotion-tool.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const tool = beliefPromotionScanTool(engine, testPromotionConfig);

    const output = await tool.execute({}) as string;

    assert.ok(output.includes('BELIEF PROMOTION SCAN'), 'output should have scan header');
    assert.ok(output.includes('Would promote') || output.includes('Would skip'), 'output should show promotion counts');

    await cleanup(pool, [packetId], [candidateId]);
  });

  it('scan tool returns graceful message when promotion is disabled', async () => {
    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const { beliefPromotionScanTool } = await import('../dist/belief-promotion-tool.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), { ...testPromotionConfig, enabled: false });
    const tool = beliefPromotionScanTool(engine, { ...testPromotionConfig, enabled: false });

    const output = await tool.execute({}) as string;
    assert.ok(output.includes('disabled'), 'should mention disabled state');
  });

  it('scan tool on empty queue does not fail', async () => {
    const { BeliefPromotionEngine } = await import('../dist/belief-promotion.js');
    const { beliefPromotionScanTool } = await import('../dist/belief-promotion-tool.js');
    const engine = new BeliefPromotionEngine(pool as any, makePromotionMemoryManager(pool), testPromotionConfig);
    const tool = beliefPromotionScanTool(engine, testPromotionConfig);

    const output = await tool.execute({ minConfidence: 0.99, minReinforcement: 999 }) as string;
    assert.ok(output.includes('SCAN'), 'should return scan output');
    assert.ok(output.includes('Would promote: 0'), 'should show zero promotions');
  });
});

// ============================================================================
// Phase 4G: Tool registration
// ============================================================================

describe('Phase 4G: tool registration', () => {
  it('csm_belief_promotion_scan is registered in CSM_TOOL_NAMES', async () => {
    const { CSM_TOOL_NAMES } = await import('../dist/tool-names.js');
    assert.ok(CSM_TOOL_NAMES.includes('csm_belief_promotion_scan'), 'csm_belief_promotion_scan should be in CSM_TOOL_NAMES');
  });

  it('csm_belief_promote is registered in CSM_TOOL_NAMES', async () => {
    const { CSM_TOOL_NAMES } = await import('../dist/tool-names.js');
    assert.ok(CSM_TOOL_NAMES.includes('csm_belief_promote'), 'csm_belief_promote should be in CSM_TOOL_NAMES');
  });

  it('tool count is 35 (34 + 1 wiki export tool)', async () => {
    const { CSM_TOOL_NAMES } = await import('../dist/tool-names.js');
    assert.equal(CSM_TOOL_NAMES.length, 35, `expected 35 tools, got ${CSM_TOOL_NAMES.length}`);
  });
});

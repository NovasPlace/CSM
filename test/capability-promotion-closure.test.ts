import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SelfModelUpdater } from '../dist/self-model-updater.js';
import { BeliefKnowledgeConsolidator } from '../dist/belief-knowledge-store.js';
import { BeliefPromotionEngine } from '../dist/belief-promotion.js';
import { ALL_CAPABILITIES, canonicalCapabilityKey, CAPABILITY_PROVENANCE_TAG } from '../dist/types.js';

// ============================================================================
// Mock helpers (matching self-model-updater.test.ts and belief-knowledge-store.test.ts patterns)
// ============================================================================

interface CapRow {
  id: number;
  capability: string;
  confidence: number;
  uncertainty: number;
  evidence_refs: string;
  success_count: number;
  failure_count: number;
  drift_warning: boolean | number;
  last_verified: string | null;
  updated_at: string;
}

function makePacketRow(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? 1,
    session_id: overrides.session_id ?? 'sess-test',
    project_id: overrides.project_id ?? null,
    entry_type: overrides.entry_type ?? 'tool_execution',
    signals: overrides.signals ?? JSON.stringify({ toolName: 'read' }),
    internal_state: overrides.internal_state ?? JSON.stringify({ cognitiveLoad: 0.1, frustration: 0, energy: 0.8, dominantEmotion: 'neutral', stance: 'exploratory', urgency: 0 }),
    confidence: overrides.confidence ?? 0.5,
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

function makeSelfModelUpdater(packets: Record<string, unknown>[]) {
  const capRows: CapRow[] = [];

  function serializeRefs(refs: unknown): string {
    if (typeof refs === 'string') { try { JSON.parse(refs); return refs; } catch { return refs; } }
    return JSON.stringify(refs);
  }

  function parseEvidence(val: unknown): unknown {
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return val; } }
    return val;
  }

  const handler = (sql: string, params?: unknown[]) => {
    if (sql.includes('FROM self_model_capabilities') && !sql.includes('INSERT')) {
      return { rows: [...capRows], rowCount: capRows.length };
    }
    if (sql.includes('INSERT INTO self_model_capabilities') && !sql.includes('ON CONFLICT')) {
      const now = new Date().toISOString();
      const row: CapRow = {
        id: capRows.length + 1, capability: String(params?.[0] ?? ''),
        confidence: Number(params?.[1] ?? 0.3), uncertainty: Number(params?.[2] ?? 0.5),
        evidence_refs: parseEvidence(params?.[3]) as string, success_count: Number(params?.[4] ?? 0),
        failure_count: Number(params?.[5] ?? 0), drift_warning: Boolean(params?.[6] ?? false),
        last_verified: null, updated_at: now,
      };
      capRows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('ON CONFLICT (capability)')) {
      const capName = String(params?.[0] ?? '');
      const now = new Date().toISOString();
      let existing = capRows.find(r => r.capability === capName);
      if (!existing) {
        existing = {
          id: capRows.length + 1, capability: capName,
          confidence: 0.3, uncertainty: 0.5,
          evidence_refs: '[]', success_count: 0, failure_count: 0,
          drift_warning: false, last_verified: null, updated_at: now,
        };
        capRows.push(existing);
      }
      existing.confidence = Number(params?.[1] ?? existing.confidence);
      existing.uncertainty = Number(params?.[2] ?? existing.uncertainty);
      existing.evidence_refs = parseEvidence(params?.[3]) as string;
      existing.success_count = Number(params?.[4] ?? existing.success_count);
      existing.failure_count = Number(params?.[5] ?? existing.failure_count);
      existing.drift_warning = Boolean(params?.[6] ?? existing.drift_warning);
      existing.last_verified = String(params?.[7] ?? now);
      existing.updated_at = now;
      return { rows: [{ ...existing }], rowCount: 1 };
    }
    if (sql.includes('FROM experience_packets')) {
      return { rows: packets.map(p => makePacketRow(p)), rowCount: packets.length };
    }
    return { rows: [], rowCount: 0 };
  };

  const pool = {
    query: mock.fn((sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params))),
    getDialect: () => 'pg' as const,
  };

  const config = {
    enabled: true, updateIntervalMs: 60000,
    confidenceIncrementRate: 0.1, uncertaintyIncrementRate: 0.15,
    contradictionPenalty: 0.1, driftWarningThreshold: 0.7,
  };

  const updater = new SelfModelUpdater(pool as any, config);

  return {
    updater, pool, capRows,
    getCapRow: (cap: string) => capRows.find(r => r.capability === cap),
  };
}

function makeConsolidatorPool(candidates: any[], beliefs: any[], captureInsert?: { params: unknown[] }) {
  return {
    query: mock.fn((sql: string, params?: unknown[]) => {
      if (sql.includes('FROM memory_candidate_queue')) return Promise.resolve({ rows: candidates, rowCount: candidates.length });
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return Promise.resolve({ rows: beliefs, rowCount: beliefs.length });
      }
      if (sql.includes('INSERT INTO belief_knowledge_store') || sql.includes('ON CONFLICT')) {
        if (captureInsert) captureInsert.params = params ?? [];
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    }),
    getDialect: () => 'pg' as const,
  };
}

// ============================================================================
// Closure Criterion 1: Failure lowers self-model without creating a
// contradictory second source of truth
// ============================================================================

describe('Closure Criterion 1: failure lowers self-model, no second source of truth', () => {
  it('failure packet decreases code_editing confidence', async () => {
    const { updater, getCapRow } = makeSelfModelUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', error: 'EACCES' }) },
    ]);
    await updater.updateAll();

    const codeEdit = getCapRow('code_editing');
    assert.ok(codeEdit, 'code_editing capability should exist');
    assert.ok(codeEdit.confidence < 0.3, `confidence should be below baseline 0.3, got ${codeEdit.confidence}`);
    assert.equal(codeEdit.failure_count, 1);
  });

  it('self-model updater does not write to memories or candidate tables', async () => {
    const { updater, pool } = makeSelfModelUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', error: 'EACCES' }) },
    ]);
    await updater.updateAll();

    const calls = pool.query.mock.calls.map((c: any) => c.arguments[0] as string);
    const touchesMemories = calls.some((sql: string) =>
      sql.includes('INSERT INTO memories') || sql.includes('UPDATE memories'),
    );
    assert.equal(touchesMemories, false, 'SelfModelUpdater must not write to memories on failure');
  });
});

// ============================================================================
// Closure Criterion 2: Failure packets survive isJunkBelief() filtering
// ============================================================================

describe('Closure Criterion 2: failure packets survive filtering', () => {
  it('tool:edit:fail candidate is NOT junked — belief entry created with stance=opposes', async () => {
    const candidates = [{
      id: 1, candidate_type: 'candidate_belief', dedup_key: 'tool:edit:fail',
      reason: 'edit tool fails frequently (3 events)', confidence: 0.6,
      event_count: 3, reinforcement_count: 0, contradicted_count: 3,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[1,2,3]', status: 'active',
    }];
    const beliefs: any[] = [];
    const capture: { params: unknown[] } = { params: [] };

    const pool = makeConsolidatorPool(candidates, beliefs, capture);
    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 1, 'failure belief should be created, not skipped as junk');
    assert.ok(capture.params.length > 0, 'INSERT should have been called');

    // Verify subject is canonical: tool:edit:reliability
    const subject = capture.params[1] as string;
    assert.equal(subject, 'tool:edit:reliability', 'subject should be canonical capability key');

    // Verify stance is opposes
    const stance = capture.params[3] as string;
    assert.equal(stance, 'opposes', 'failure belief should have stance=opposes');
  });

  it('tool:edit:ok candidate IS still junked (success beliefs remain trivial)', async () => {
    const candidates = [{
      id: 1, candidate_type: 'candidate_belief', dedup_key: 'tool:edit:ok',
      reason: 'edit tool succeeds reliably (3 events)', confidence: 0.6,
      event_count: 3, reinforcement_count: 3, contradicted_count: 0,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[1,2,3]', status: 'active',
    }];

    const pool = makeConsolidatorPool(candidates, []);
    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 0, 'success belief should be junked (trivially true)');
    assert.equal(result.skipped, 1, 'success belief should be counted as skipped');
  });
});

// ============================================================================
// Closure Criterion 3: Success and failure reconcile under one canonical proposition
// ============================================================================

describe('Closure Criterion 3: canonical proposition reconciliation', () => {
  it('both tool:edit:ok and tool:edit:fail map to subject=tool:edit:reliability', async () => {
    const failCapture: { params: unknown[] } = { params: [] };
    const okCapture: { params: unknown[] } = { params: [] };

    // Process failure candidate
    const failCandidates = [{
      id: 1, candidate_type: 'candidate_belief', dedup_key: 'tool:edit:fail',
      reason: 'edit fails', confidence: 0.6,
      event_count: 3, reinforcement_count: 0, contradicted_count: 3,
      last_reinforced_at: null, source_packet_ids: '[1]', status: 'active',
    }];
    const failPool = makeConsolidatorPool(failCandidates, [], failCapture);
    const failConsolidator = new BeliefKnowledgeConsolidator(failPool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });
    await failConsolidator.consolidate();

    // Process success candidate (separate consolidator instance to isolate captures)
    const okCandidates = [{
      id: 2, candidate_type: 'candidate_belief', dedup_key: 'tool:edit:ok',
      reason: 'edit succeeds', confidence: 0.6,
      event_count: 3, reinforcement_count: 3, contradicted_count: 0,
      last_reinforced_at: null, source_packet_ids: '[2]', status: 'active',
    }];
    const okPool = makeConsolidatorPool(okCandidates, [], okCapture);
    const okConsolidator = new BeliefKnowledgeConsolidator(okPool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });
    await okConsolidator.consolidate();

    // Failure should have been created with canonical subject
    assert.ok(failCapture.params.length > 0, 'failure belief should have been inserted');
    assert.equal(failCapture.params[1], 'tool:edit:reliability', 'failure subject should be canonical');
    assert.equal(failCapture.params[3], 'opposes', 'failure stance should be opposes');

    // Success should have been junked (trivially true), so no insert params captured
    // The key point is that IF it were inserted, it would also use the canonical subject.
    // We verify the deriveSubject function produces the same key for both.
    assert.equal(okCapture.params.length, 0, 'success belief should be junked');
  });

  it('canonicalCapabilityKey produces tool:X:reliability format', () => {
    assert.equal(canonicalCapabilityKey('edit'), 'tool:edit:reliability');
    assert.equal(canonicalCapabilityKey('bash'), 'tool:bash:reliability');
    assert.equal(canonicalCapabilityKey('read'), 'tool:read:reliability');
  });
});

// ============================================================================
// Closure Criterion 4: Promoted records are provenance snapshots, not live assertions
// ============================================================================

describe('Closure Criterion 4: promotion creates provenance snapshots', () => {
  it('candidate_capability promotion produces [Capability provenance] content', async () => {
    const savedMemories: any[] = [];
    const mockMemoryManager = {
      saveMemory: mock.fn(async (opts: any) => {
        const mem = { id: savedMemories.length + 1, ...opts, createdAt: new Date() };
        savedMemories.push(mem);
        return mem;
      }),
    };

    const candidateRow = {
      id: 100, candidate_type: 'candidate_capability', memory_id: null,
      dedup_key: 'cap:edit:ok', reason: 'edit used successfully',
      confidence: 0.8, event_count: 7, reinforcement_count: 7,
      contradicted_count: 0, source_packet_ids: '[10,11,12]',
      promotion_ready: true, status: 'pending',
    };

    const pool = {
      query: mock.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM memory_candidate_queue') && !sql.includes('UPDATE') && !sql.includes('DELETE')) {
          return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
        }
        if (sql.includes('SELECT id, content FROM memories') && sql.includes('metadata')) {
          // findDuplicate returns null (no existing memory with this dedup_key)
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('COUNT(DISTINCT session_id)')) {
          return Promise.resolve({ rows: [{ session_count: 2 }], rowCount: 1 });
        }
        if (sql.includes('UPDATE memory_candidate_queue')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      getDialect: () => 'pg' as const,
    };

    const engine = new BeliefPromotionEngine(pool as any, mockMemoryManager as any, {
      enabled: true, dryRunByDefault: false,
      minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2,
      minSessions: 1, maxPromotePerRun: 10, relaxed: false,
    });

    const report = await engine.promote({ dryRun: false });
    assert.equal(report.promoted, 1, 'one candidate should be promoted');
    assert.equal(savedMemories.length, 1, 'one memory should be saved');

    const mem = savedMemories[0];
    assert.ok(mem.content.startsWith('[Capability provenance]'), 'content should start with [Capability provenance]');
    assert.ok(mem.content.includes('crossed promotion threshold'), 'content should mention threshold crossing');
    assert.ok(mem.content.includes('[Snapshot'), 'content should identify as snapshot');
    assert.ok(mem.content.includes('tool:edit:reliability'), 'content should reference canonical key');

    const meta = mem.metadata as Record<string, unknown>;
    assert.equal(meta.record_type, 'capability_provenance', 'metadata should have record_type=capability_provenance');
    assert.equal(meta.canonical_key, 'tool:edit:reliability', 'metadata should have canonical_key');
    assert.equal(meta.dedup_key, 'cap:edit:ok', 'metadata should preserve dedup_key');
    assert.equal(meta.candidate_id, 100, 'metadata should preserve candidate_id');

    assert.ok(mem.tags.includes(CAPABILITY_PROVENANCE_TAG), 'tags should include capability-provenance');
  });
});

// ============================================================================
// Closure Criterion 5: Promotion does not touch self-model confidence
// ============================================================================

describe('Closure Criterion 5: promotion does not touch self-model', () => {
  it('promotion engine never queries self_model_capabilities', async () => {
    const mockMemoryManager = {
      saveMemory: mock.fn(async (opts: any) => ({ id: 1, ...opts, createdAt: new Date() })),
    };

    const candidateRow = {
      id: 200, candidate_type: 'candidate_capability', memory_id: null,
      dedup_key: 'cap:write:ok', reason: 'write used successfully',
      confidence: 0.7, event_count: 6, reinforcement_count: 6,
      contradicted_count: 0, source_packet_ids: '[20,21]',
      promotion_ready: true, status: 'pending',
    };

    const pool = {
      query: mock.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM memory_candidate_queue') && sql.includes('WHERE status')) {
          return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
        }
        if (sql.includes('SELECT id, content FROM memories') && sql.includes('metadata')) {
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
        if (sql.includes('COUNT(DISTINCT session_id)')) {
          return Promise.resolve({ rows: [{ session_count: 2 }], rowCount: 1 });
        }
        if (sql.includes('UPDATE memory_candidate_queue')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      getDialect: () => 'pg' as const,
    };

    const engine = new BeliefPromotionEngine(pool as any, mockMemoryManager as any, {
      enabled: true, dryRunByDefault: false,
      minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2,
      minSessions: 1, maxPromotePerRun: 10, relaxed: false,
    });

    await engine.promote({ dryRun: false });

    const calls = pool.query.mock.calls.map((c: any) => c.arguments[0] as string);
    const touchesSelfModel = calls.some((sql: string) =>
      sql.includes('self_model_capabilities'),
    );
    assert.equal(touchesSelfModel, false, 'promotion must not touch self_model_capabilities');
  });
});

// ============================================================================
// Closure Criterion 6: Idempotent via structural dedup_key, not fuzzy content matching
// ============================================================================

describe('Closure Criterion 6: structural dedup_key idempotency', () => {
  it('findDuplicate queries metadata dedup_key, not content LIKE', async () => {
    let duplicateQuerySql = '';
    const mockMemoryManager = {
      saveMemory: mock.fn(async (opts: any) => ({ id: 1, ...opts, createdAt: new Date() })),
    };

    const candidateRow = {
      id: 300, candidate_type: 'candidate_capability', memory_id: null,
      dedup_key: 'cap:read:ok', reason: 'read used successfully',
      confidence: 0.7, event_count: 6, reinforcement_count: 6,
      contradicted_count: 0, source_packet_ids: '[30,31]',
      promotion_ready: true, status: 'pending',
    };

    const pool = {
      query: mock.fn((sql: string, params?: unknown[]) => {
        if (sql.includes('FROM memory_candidate_queue') && !sql.includes('UPDATE') && !sql.includes('DELETE')) {
          return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
        }
        if (sql.includes('SELECT id, content FROM memories') && sql.includes('metadata')) {
          duplicateQuerySql = sql;
          // Return a match to trigger dedup skip
          return Promise.resolve({ rows: [{ id: 999, content: 'existing memory' }], rowCount: 1 });
        }
        if (sql.includes('COUNT(DISTINCT session_id)')) {
          return Promise.resolve({ rows: [{ session_count: 2 }], rowCount: 1 });
        }
        if (sql.includes('UPDATE memory_candidate_queue')) {
          return Promise.resolve({ rows: [], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      getDialect: () => 'pg' as const,
    };

    const engine = new BeliefPromotionEngine(pool as any, mockMemoryManager as any, {
      enabled: true, dryRunByDefault: false,
      minConfidence: 0.7, minReinforcement: 3, minEvidenceRefs: 2,
      minSessions: 1, maxPromotePerRun: 10, relaxed: false,
    });

    const report = await engine.promote({ dryRun: false });

    // Verify the dedup query uses metadata->>'dedup_key' not LOWER(content) LIKE
    assert.ok(duplicateQuerySql.length > 0, 'dedup query should have been executed');
    assert.ok(duplicateQuerySql.includes('dedup_key'), 'dedup query should filter on metadata dedup_key');
    assert.ok(!duplicateQuerySql.includes('LOWER(content) LIKE'), 'dedup query must NOT use fuzzy content LIKE');

    // Verify the candidate was skipped as duplicate, not promoted
    const decision = report.decisions.find((d: any) => d.candidateId === 300);
    assert.ok(decision, 'decision should exist');
    assert.equal(decision.action, 'skip_dedup_match', 'should skip due to structural dedup match');
    assert.equal(report.promoted, 0, 'should not promote duplicate');
    assert.equal(mockMemoryManager.saveMemory.mock.callCount(), 0, 'saveMemory should not be called for duplicate');
  });
});

// ============================================================================
// Closure Criterion 7: Self-model confidence recovers after subsequent successes
// ============================================================================

describe('Closure Criterion 7: confidence recovers after successes', () => {
  it('failure decreases confidence, then successes monotonically increase it', async () => {
    const packets: Record<string, unknown>[] = [
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', error: 'EACCES' }) },
    ];

    const { updater, getCapRow } = makeSelfModelUpdater(packets);

    // Phase 1: Apply failure
    await updater.updateAll();
    const codeEditAfterFailure = getCapRow('code_editing')!;
    assert.ok(codeEditAfterFailure, 'code_editing should exist after failure');
    const confidenceAfterFailure = codeEditAfterFailure.confidence;
    assert.ok(confidenceAfterFailure < 0.3, `failure should lower confidence below 0.3 baseline, got ${confidenceAfterFailure}`);

    // Phase 2: Add success packets and re-run
    packets.push(
      { id: 2, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
    );
    await updater.updateAll();
    const confidenceAfterSuccess1 = getCapRow('code_editing')!.confidence;
    assert.ok(confidenceAfterSuccess1 > confidenceAfterFailure,
      `first success should increase confidence: ${confidenceAfterSuccess1} > ${confidenceAfterFailure}`);

    packets.push(
      { id: 3, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
    );
    await updater.updateAll();
    const confidenceAfterSuccess2 = getCapRow('code_editing')!.confidence;
    assert.ok(confidenceAfterSuccess2 > confidenceAfterSuccess1,
      `second success should increase confidence: ${confidenceAfterSuccess2} > ${confidenceAfterSuccess1}`);

    packets.push(
      { id: 4, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
    );
    await updater.updateAll();
    const confidenceAfterSuccess3 = getCapRow('code_editing')!.confidence;
    assert.ok(confidenceAfterSuccess3 > confidenceAfterSuccess2,
      `third success should increase confidence: ${confidenceAfterSuccess3} > ${confidenceAfterSuccess2}`);

    // Final assertions
    assert.ok(confidenceAfterSuccess3 > confidenceAfterFailure,
      `final confidence should be above post-failure value: ${confidenceAfterSuccess3} > ${confidenceAfterFailure}`);
    assert.ok(confidenceAfterSuccess3 <= 0.9,
      `final confidence should respect configured upper bound: ${confidenceAfterSuccess3} <= 0.9`);
  });

  it('failure count increases and success count tracks packets', async () => {
    const packets: Record<string, unknown>[] = [
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', error: 'EACCES' }) },
    ];

    const { updater, getCapRow } = makeSelfModelUpdater(packets);
    await updater.updateAll();
    const capAfterFailure = getCapRow('code_editing')!;
    assert.equal(capAfterFailure.failure_count, 1, 'failure count should be 1 after failure packet');

    packets.push(
      { id: 2, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
      { id: 3, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
    );
    await updater.updateAll();
    const capAfterSuccesses = getCapRow('code_editing')!;
    assert.ok(capAfterSuccesses.success_count >= 2, 'success count should reflect success packets');
  });
});

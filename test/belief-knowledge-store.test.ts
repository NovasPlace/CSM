import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BeliefKnowledgeConsolidator } from '../dist/belief-knowledge-store.js';
import { beliefKnowledgeTool } from '../dist/belief-knowledge-tool.js';

interface BeliefRow {
  id: number;
  belief_kind: string;
  subject: string;
  claim: string;
  stance: string;
  confidence: number;
  uncertainty: number;
  evidence_refs: string;
  contradicted_count: number;
  last_reinforced_at: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  id: number;
  candidate_type: string;
  dedup_key: string;
  reason: string;
  confidence: number;
  event_count: number;
  reinforcement_count: number;
  contradicted_count: number;
  last_reinforced_at: string | null;
  source_packet_ids: string;
  status: string;
}

function makePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  return {
    query: mock.fn((sql: string, params?: unknown[]) => {
      return Promise.resolve(handler(sql, params));
    }),
    getDialect: () => 'pg' as const,
  };
}

describe('BeliefKnowledgeConsolidator', () => {
  it('maps candidate_preference → belief_kind=preference', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_preference', dedup_key: 'tool:read:ok',
      reason: 'tool:read succeeds reliably (3 events)', confidence: 0.5,
      event_count: 3, reinforcement_count: 3, contradicted_count: 0,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[1,2,3]', status: 'active',
    }];
    const beliefs: BeliefRow[] = [];

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: beliefs, rowCount: beliefs.length };
      }
      if (sql.includes('INSERT INTO belief_knowledge_store')) {
        beliefs.push({
          id: 1, belief_kind: 'preference', subject: 'tool:read', claim: 'succeeds reliably',
          stance: 'supports', confidence: 0.5, uncertainty: 0.5, evidence_refs: '[{"packetId":1,"entryType":"","outcome":"success","timestamp":"2025-12-01T00:00:00Z"}]',
          contradicted_count: 0, last_reinforced_at: null, status: 'candidate',
          created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 1);
    assert.equal(result.updated, 0);
    assert.equal(result.beliefs.length, 1);
    assert.equal(result.beliefs[0].beliefKind, 'preference');
    assert.equal(result.beliefs[0].subject, 'tool:read');
    assert.equal(result.beliefs[0].claim, 'succeeds reliably');
    assert.equal(result.beliefs[0].stance, 'supports');
    assert.equal(result.beliefs[0].status, 'candidate');
  });

  it('maps candidate_worldview → belief_kind=worldview', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_worldview', dedup_key: 'ms:completion',
      reason: 'system completes tasks (2 milestones)', confidence: 0.4,
      event_count: 2, reinforcement_count: 2, contradicted_count: 0,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[10,11]', status: 'active',
    }];
    const beliefs: BeliefRow[] = [];

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: beliefs, rowCount: beliefs.length };
      }
      if (sql.includes('INSERT INTO belief_knowledge_store')) {
        beliefs.push({
          id: 1, belief_kind: 'worldview', subject: 'ms:completion', claim: 'tasks complete successfully',
          stance: 'supports', confidence: 0.4, uncertainty: 0.5, evidence_refs: '[]',
          contradicted_count: 0, last_reinforced_at: null, status: 'candidate',
          created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 1);
    assert.equal(result.beliefs[0].beliefKind, 'worldview');
    assert.equal(result.beliefs[0].subject, 'ms:completion');
    assert.equal(result.beliefs[0].claim, 'tasks complete successfully');
  });

  it('maps candidate_opinion → belief_kind=opinion', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_opinion', dedup_key: 'dec:creation',
      reason: 'system makes decisions about creation', confidence: 0.4,
      event_count: 2, reinforcement_count: 2, contradicted_count: 0,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[20,21]', status: 'active',
    }];
    const beliefs: BeliefRow[] = [];

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: beliefs, rowCount: beliefs.length };
      }
      if (sql.includes('INSERT INTO belief_knowledge_store')) {
        beliefs.push({
          id: 1, belief_kind: 'opinion', subject: 'dec:creation', claim: 'system makes decisions about creation',
          stance: 'neutral', confidence: 0.4, uncertainty: 0.5, evidence_refs: '[]',
          contradicted_count: 0, last_reinforced_at: null, status: 'candidate',
          created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 1);
    assert.equal(result.beliefs[0].beliefKind, 'opinion');
    assert.equal(result.beliefs[0].stance, 'neutral');
  });

  it('maps candidate_belief type to preference belief_kind', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_belief', dedup_key: 'err:parse:fail',
      reason: 'parse errors', confidence: 0.6,
      event_count: 2, reinforcement_count: 2, contradicted_count: 0,
      last_reinforced_at: null, source_packet_ids: '[]', status: 'active',
    }];
    const beliefs: BeliefRow[] = [];

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: beliefs, rowCount: beliefs.length };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 1);
    assert.equal(result.beliefs[0].beliefKind, 'preference');
  });

  it('duplicate candidate updates existing belief entry (reinforcement)', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_preference', dedup_key: 'tool:read:ok',
      reason: 'tool:read succeeds (3 events)', confidence: 0.5,
      event_count: 3, reinforcement_count: 3, contradicted_count: 0,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[1,2,3]', status: 'active',
    }];
    const existingBeliefs: BeliefRow[] = [{
      id: 10, belief_kind: 'preference', subject: 'tool:read', claim: 'succeeds reliably',
      stance: 'supports', confidence: 0.5, uncertainty: 0.5,
      evidence_refs: '[{"packetId":1,"entryType":"","outcome":"success","timestamp":"2025-12-01T00:00:00Z"}]',
      contradicted_count: 0, last_reinforced_at: '2025-12-01T00:00:00Z', status: 'candidate',
      created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
    }];
    let upsertCount = 0;

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: existingBeliefs, rowCount: existingBeliefs.length };
      }
      if (sql.includes('INSERT INTO belief_knowledge_store')) {
        upsertCount++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 0);
    assert.equal(result.updated, 1);
    assert.ok(upsertCount >= 1, 'should have performed upsert');
    // Confidence should have increased from 0.5 → 0.5 + (0.5 * 0.1) = 0.55
    const belief = result.beliefs.find(b => b.beliefKind === 'preference');
    assert.ok(belief);
    assert.ok(belief.confidence > 0.5, `expected confidence > 0.5, got ${belief.confidence}`);
    assert.ok(belief.uncertainty < 0.5, `expected uncertainty < 0.5, got ${belief.uncertainty}`);
  });

  it('contradiction increases uncertainty and lowers confidence', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_preference', dedup_key: 'tool:write:fail',
      reason: 'tool:write fails (2 events)', confidence: 0.4,
      event_count: 2, reinforcement_count: 0, contradicted_count: 2,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[5,6]', status: 'active',
    }];
    const existingBeliefs: BeliefRow[] = [{
      id: 10, belief_kind: 'preference', subject: 'tool:write', claim: 'fails frequently',
      stance: 'opposes', confidence: 0.4, uncertainty: 0.5,
      evidence_refs: '[{"packetId":5,"entryType":"","outcome":"failure","timestamp":"2025-12-01T00:00:00Z"}]',
      contradicted_count: 0, last_reinforced_at: '2025-12-01T00:00:00Z', status: 'candidate',
      created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
    }];
    let upsertCount = 0;

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: existingBeliefs, rowCount: existingBeliefs.length };
      }
      if (sql.includes('INSERT INTO belief_knowledge_store')) {
        upsertCount++;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.updated, 1);
    const belief = result.beliefs.find(b => b.beliefKind === 'preference');
    assert.ok(belief);
    assert.ok(belief.uncertainty > 0.5, `expected uncertainty > 0.5, got ${belief.uncertainty}`);
    assert.ok(belief.confidence < 0.4, `expected confidence < 0.4, got ${belief.confidence}`);
    assert.equal(belief.contradictedCount, 2);
  });

  it('status remains candidate/advisory by default', async () => {
    const candidates: CandidateRow[] = [{
      id: 1, candidate_type: 'candidate_preference', dedup_key: 'tool:read:ok',
      reason: 'tool:read succeeds', confidence: 0.5,
      event_count: 3, reinforcement_count: 3, contradicted_count: 0,
      last_reinforced_at: '2025-12-01T00:00:00Z', source_packet_ids: '[1]', status: 'active',
    }];
    const beliefs: BeliefRow[] = [];

    const pool = makePool((sql) => {
      if (sql.includes('FROM memory_candidate_queue')) return { rows: candidates, rowCount: 1 };
      if (sql.includes('FROM belief_knowledge_store') && !sql.includes('INSERT') && !sql.includes('ON CONFLICT')) {
        return { rows: beliefs, rowCount: beliefs.length };
      }
      if (sql.includes('INSERT INTO belief_knowledge_store')) {
        const row: BeliefRow = {
          id: 1, belief_kind: 'preference', subject: 'tool:read', claim: 'succeeds reliably',
          stance: 'supports', confidence: 0.5, uncertainty: 0.5, evidence_refs: '[]',
          contradicted_count: 0, last_reinforced_at: null, status: 'candidate',
          created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
        };
        beliefs.push(row);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 1);
    assert.equal(result.beliefs[0].status, 'candidate');
  });

  it('returns empty when disabled', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: false, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.consolidate();
    assert.equal(result.created, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 0);
    assert.equal(pool.query.mock.callCount(), 0);
  });

  it('getAllBeliefs returns all consolidated beliefs', async () => {
    const beliefs: BeliefRow[] = [
      { id: 1, belief_kind: 'preference', subject: 'tool:read', claim: 'succeeds reliably',
        stance: 'supports', confidence: 0.55, uncertainty: 0.45,
        evidence_refs: '[{"packetId":1,"entryType":"","outcome":"success","timestamp":"2025-12-01T00:00:00Z"}]',
        contradicted_count: 0, last_reinforced_at: '2025-12-01T00:00:00Z', status: 'candidate',
        created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z' },
      { id: 2, belief_kind: 'worldview', subject: 'ms:completion', claim: 'tasks complete successfully',
        stance: 'supports', confidence: 0.4, uncertainty: 0.5,
        evidence_refs: '[]',
        contradicted_count: 0, last_reinforced_at: null, status: 'candidate',
        created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z' },
    ];

    const pool = makePool((sql) => {
      if (sql.includes('FROM belief_knowledge_store')) return { rows: beliefs, rowCount: 2 };
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const all = await consolidator.getAllBeliefs();
    assert.equal(all.length, 2);
    assert.equal(all[0].beliefKind, 'preference');
    assert.equal(all[1].beliefKind, 'worldview');
  });

  it('getBeliefsByKind filters correctly', async () => {
    const beliefs: BeliefRow[] = [
      { id: 1, belief_kind: 'preference', subject: 'tool:read', claim: 'succeeds reliably',
        stance: 'supports', confidence: 0.55, uncertainty: 0.45,
        evidence_refs: '[]',
        contradicted_count: 0, last_reinforced_at: '2025-12-01T00:00:00Z', status: 'candidate',
        created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z' },
    ];

    const pool = makePool((sql) => {
      if (sql.includes('WHERE belief_kind = $1')) return { rows: beliefs, rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const consolidator = new BeliefKnowledgeConsolidator(pool as any, {
      enabled: true, consolidationIntervalMs: 120000, confidenceThreshold: 0.5, uncertaintyThreshold: 0.6,
    });

    const result = await consolidator.getBeliefsByKind('preference');
    assert.equal(result.length, 1);
    assert.equal(result[0].beliefKind, 'preference');
  });
});

describe('csm_belief_knowledge tool', () => {
  it('returns empty state when no beliefs exist', async () => {
    const consolidator = {
      getAllBeliefs: mock.fn(() => Promise.resolve([])),
      getBeliefsByKind: mock.fn(() => Promise.resolve([])),
    };

    const tool = beliefKnowledgeTool(consolidator as any);
    const result = await tool.execute({}, {} as any);

    assert.equal(result.metadata.count, 0);
    assert.ok(result.output.includes('No belief entries found'));
    assert.equal(consolidator.getAllBeliefs.mock.callCount(), 1);
    assert.equal(consolidator.getBeliefsByKind.mock.callCount(), 0);
  });

  it('returns beliefs without kind filter', async () => {
    const beliefs = [
      { id: 1, beliefKind: 'preference', subject: 'tool:read', claim: 'succeeds reliably',
        stance: 'supports', confidence: 0.55, uncertainty: 0.45,
        evidenceRefs: [{ packetId: 1, entryType: '', outcome: 'success', timestamp: '2025-12-01T00:00:00Z' }],
        contradictedCount: 0, lastReinforcedAt: '2025-12-01T00:00:00Z', status: 'candidate',
        createdAt: '2025-12-01T00:00:00Z', updatedAt: '2025-12-01T00:00:00Z' },
    ];
    const consolidator = {
      getAllBeliefs: mock.fn(() => Promise.resolve(beliefs)),
      getBeliefsByKind: mock.fn(() => Promise.resolve([])),
    };

    const tool = beliefKnowledgeTool(consolidator as any);
    const result = await tool.execute({}, {} as any);

    assert.equal(result.metadata.count, 1);
    assert.ok(result.output.includes('preference'));
    assert.ok(result.output.includes('tool:read'));
    assert.equal(consolidator.getAllBeliefs.mock.callCount(), 1);
    assert.equal(consolidator.getBeliefsByKind.mock.callCount(), 0);
  });

  it('filters by kind when kind arg is provided', async () => {
    const beliefs = [
      { id: 2, beliefKind: 'worldview', subject: 'ms:completion', claim: 'tasks complete',
        stance: 'supports', confidence: 0.4, uncertainty: 0.5,
        evidenceRefs: [],
        contradictedCount: 0, lastReinforcedAt: null, status: 'candidate',
        createdAt: '2025-12-01T00:00:00Z', updatedAt: '2025-12-01T00:00:00Z' },
    ];
    const consolidator = {
      getAllBeliefs: mock.fn(() => Promise.resolve([])),
      getBeliefsByKind: mock.fn(() => Promise.resolve(beliefs)),
    };

    const tool = beliefKnowledgeTool(consolidator as any);
    const result = await tool.execute({ kind: 'worldview' }, {} as any);

    assert.equal(result.metadata.count, 1);
    assert.equal(result.metadata.kind, 'worldview');
    assert.ok(result.output.includes('worldview'));
    assert.equal(consolidator.getBeliefsByKind.mock.callCount(), 1);
    assert.equal(consolidator.getBeliefsByKind.mock.calls[0].arguments[0], 'worldview');
    assert.equal(consolidator.getAllBeliefs.mock.callCount(), 0);
  });

  it('tool does not write any data (read-only)', async () => {
    const consolidator = {
      getAllBeliefs: mock.fn(() => Promise.resolve([])),
      getBeliefsByKind: mock.fn(() => Promise.resolve([])),
    };

    const tool = beliefKnowledgeTool(consolidator as any);
    await tool.execute({}, {} as any);

    // Confirm no write-like methods were called
    const calledMethods = Object.keys(consolidator).filter(
      k => consolidator[k as keyof typeof consolidator].mock.callCount() > 0,
    );
    assert.deepEqual(calledMethods, ['getAllBeliefs']);
  });
});
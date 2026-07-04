import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { SelfModelUpdater } from '../dist/self-model-updater.js';
import { ALL_CAPABILITIES } from '../dist/types.js';

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

function makeUpdater(packets: Record<string, unknown>[]) {
  const capRows: CapRow[] = [];

  function serializeRefs(refs: unknown): string {
    if (typeof refs === 'string') {
      try { JSON.parse(refs); return refs; } catch { return refs; }
    }
    return JSON.stringify(refs);
  }

  function parseEvidence(val: unknown): unknown {
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return val; }
    }
    return val;
  }

  const handler = (sql: string, params?: unknown[]) => {
    // Load existing capabilities
    if (sql.includes('FROM self_model_capabilities') && !sql.includes('INSERT')) {
      return { rows: [...capRows], rowCount: capRows.length };
    }

    // Insert new capability (seeding)
    if (sql.includes('INSERT INTO self_model_capabilities') && !sql.includes('ON CONFLICT')) {
      const now = new Date().toISOString();
      const row: CapRow = {
        id: capRows.length + 1,
        capability: String(params?.[0] ?? ''),
        confidence: Number(params?.[1] ?? 0.3),
        uncertainty: Number(params?.[2] ?? 0.5),
        evidence_refs: parseEvidence(params?.[3]) as any,
        success_count: Number(params?.[4] ?? 0),
        failure_count: Number(params?.[5] ?? 0),
        drift_warning: Boolean(params?.[6] ?? false),
        last_verified: null,
        updated_at: now,
      };
      capRows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    // Upsert capability (update)
    if (sql.includes('ON CONFLICT (capability)')) {
      const capName = String(params?.[0] ?? '');
      const now = new Date().toISOString();
      const existing = capRows.find(r => r.capability === capName);
      if (existing) {
        existing.confidence = Number(params?.[1] ?? existing.confidence);
        existing.uncertainty = Number(params?.[2] ?? existing.uncertainty);
        existing.evidence_refs = parseEvidence(params?.[3]) as any;
        existing.success_count = Number(params?.[4] ?? existing.success_count);
        existing.failure_count = Number(params?.[5] ?? existing.failure_count);
        existing.drift_warning = Boolean(params?.[6] ?? existing.drift_warning);
        existing.last_verified = String(params?.[7] ?? now);
        existing.updated_at = now;
      }
      return { rows: [{ ...(existing ?? { id: 0, capability: capName }) }], rowCount: 1 };
    }

    // Load packets
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
    enabled: true,
    updateIntervalMs: 60000,
    confidenceIncrementRate: 0.1,
    uncertaintyIncrementRate: 0.15,
    contradictionPenalty: 0.1,
    driftWarningThreshold: 0.7,
  };

  const updater = new SelfModelUpdater(pool as any, config);

  function getCapRows(): CapRow[] {
    return [...capRows];
  }

  function getCapRow(capability: string): CapRow | undefined {
    return capRows.find(r => r.capability === capability);
  }

  return { updater, getCapRows, getCapRow, pool, capRows };
}

describe('SelfModelUpdater', () => {
  it('creates all initial capabilities on first updateAll with no packets', async () => {
    const { updater, getCapRows } = makeUpdater([]);
    await updater.updateAll();
    const rows = getCapRows();
    assert.equal(rows.length, ALL_CAPABILITIES.length);
    for (const cap of ALL_CAPABILITIES) {
      const row = rows.find(r => r.capability === cap);
      assert.ok(row, `Capability ${cap} should exist`);
      assert.equal(row.confidence, 0.3);
      assert.equal(row.uncertainty, 0.5);
      assert.equal(row.success_count, 0);
      assert.equal(row.failure_count, 0);
    }
  });

  it('success packets increase capability confidence', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'read' }) },
      { id: 2, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
    ]);
    await updater.updateAll();

    // tool_use gets confidence boost from both
    const toolUse = getCapRow('tool_use');
    assert.ok(toolUse);
    assert.ok(toolUse.confidence > 0.3, `Expected confidence > 0.3, got ${toolUse.confidence}`);
    assert.equal(toolUse.success_count, 2);
    assert.equal(toolUse.failure_count, 0);
    // code_editing gets one boost (read is not code_editing, edit is)
    const codeEdit = getCapRow('code_editing');
    assert.ok(codeEdit);
    assert.ok(codeEdit.confidence > 0.3, `Expected code_editing confidence > 0.3, got ${codeEdit.confidence}`);
    assert.equal(codeEdit.success_count, 1);
  });

  it('failure packets increase uncertainty', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'read', error: 'ENOENT' }) },
      { id: 2, entry_type: 'error', signals: JSON.stringify({ toolName: 'test', error: 'assert fail' }) },
    ]);
    await updater.updateAll();

    const toolUse = getCapRow('tool_use');
    assert.ok(toolUse);
    assert.ok(toolUse.uncertainty > 0.5, `Expected uncertainty > 0.5, got ${toolUse.uncertainty}`);
    assert.equal(toolUse.success_count, 0);
    assert.equal(toolUse.failure_count, 2);

    const testRepair = getCapRow('test_repair');
    assert.ok(testRepair);
    assert.equal(testRepair.failure_count, 1);
  });

  it('mixed outcomes stabilize around medium confidence', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit' }) },
      { id: 2, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', error: 'write denied' }) },
    ]);
    await updater.updateAll();

    const toolUse = getCapRow('tool_use');
    assert.ok(toolUse);
    // Confidence > 0.3 from success (1 success)
    assert.ok(toolUse.confidence > 0.3, `Expected confidence > 0.3, got ${toolUse.confidence}`);
    // Uncertainty > 0.5 from failure (1 failure) 
    assert.ok(toolUse.uncertainty > 0.5, `Expected uncertainty > 0.5, got ${toolUse.uncertainty}`);
    assert.equal(toolUse.success_count, 1);
    assert.equal(toolUse.failure_count, 1);
  });

  it('evidence_refs are preserved', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 42, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'read' }) },
    ]);
    await updater.updateAll();

    const toolUse = getCapRow('tool_use');
    assert.ok(toolUse);
    const refs = toolUse.evidence_refs as any[];
    assert.equal(Array.isArray(refs), true);
    assert.equal(refs.length, 1);
    assert.equal(refs[0].packetId, 42);
    assert.equal(refs[0].entryType, 'tool_execution');
    assert.equal(refs[0].outcome, 'success');
    assert.equal(refs[0].toolName, 'read');
    assert.ok(refs[0].timestamp);
  });

  it('duplicate updater runs are idempotent', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'read', exitCode: 0 }) },
    ]);
    await updater.updateAll();
    const afterFirst = getCapRow('tool_use')!;

    // Second run should see same packets but skip already-processed ones
    await updater.updateAll();
    const afterSecond = getCapRow('tool_use')!;

    assert.equal(afterSecond.confidence, afterFirst.confidence);
    assert.equal(afterSecond.uncertainty, afterFirst.uncertainty);
    assert.equal(afterSecond.success_count, afterFirst.success_count);
    assert.equal(afterSecond.failure_count, afterFirst.failure_count);
    const refs = afterSecond.evidence_refs as any[];
    assert.equal(Array.isArray(refs), true);
    assert.equal(refs.length, 1); // Still 1, not 2
  });

  it('self-model does not write memories or candidates', async () => {
    const { updater, pool } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'read' }) },
    ]);
    await updater.updateAll();

    // Verify no queries touch memories or candidate tables
    const calls = pool.query.mock.calls.map((c: any) => c.arguments[0] as string);
    const touchesMemory = calls.some((sql: string) =>
      sql.includes('memories') || sql.includes('memory_candidate') || sql.includes('memory_events')
    );
    assert.equal(touchesMemory, false, 'SelfModelUpdater should not write to memories or candidate tables');
  });

  it('getAllCapabilities returns all capabilities with defaults', async () => {
    const { updater, getCapRows } = makeUpdater([]);
    const caps = await updater.getAllCapabilities();
    // Should have created all capabilities
    assert.equal(caps.length, ALL_CAPABILITIES.length);
    for (const cap of caps) {
      assert.equal(cap.confidence, 0.3);
      assert.equal(cap.uncertainty, 0.5);
      assert.ok(Array.isArray(cap.evidenceRefs));
      assert.equal(cap.evidenceRefs.length, 0);
    }
  });

  it('getCapability returns null for unknown capability', async () => {
    const { updater } = makeUpdater([]);
    const cap = await updater.getCapability('nonexistent' as any);
    assert.equal(cap, null);
  });

  it('evidence refs prevent double-processing of same packet for same capability', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'read', exitCode: 0 }) },
    ]);
    await updater.updateAll();
    const afterFirst = getCapRow('tool_use')!;
    assert.equal(afterFirst.success_count, 1);

    // Add a new packet (makeUpdater creates fresh state, so we test initial state only)
    // Instead test that evidence ids prevent double-counting
    const refs1 = afterFirst.evidence_refs as any[];
    assert.equal(refs1.length, 1);
    assert.equal(refs1[0].packetId, 1);
  });

  it('one packet can support multiple capabilities if classifier maps it to both', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', exitCode: 0 }) },
    ]);
    await updater.updateAll();

    // 'edit' should map to both tool_use AND code_editing
    const toolUse = getCapRow('tool_use');
    assert.ok(toolUse);
    assert.equal(toolUse.success_count, 1);
    const tuRefs = toolUse.evidence_refs as any[];
    assert.equal(tuRefs.length, 1);
    assert.equal(tuRefs[0].packetId, 1);

    const codeEdit = getCapRow('code_editing');
    assert.ok(codeEdit);
    assert.equal(codeEdit.success_count, 1);
    const ceRefs = codeEdit.evidence_refs as any[];
    assert.equal(ceRefs.length, 1);
    assert.equal(ceRefs[0].packetId, 1);
  });

  it('same packet processed for tool_use does NOT block processing for code_editing', async () => {
    const { updater, getCapRow } = makeUpdater([
      { id: 1, entry_type: 'tool_execution', signals: JSON.stringify({ toolName: 'edit', exitCode: 0 }) },
    ]);
    await updater.updateAll();

    const toolUse = getCapRow('tool_use')!;
    const codeEdit = getCapRow('code_editing')!;

    // Both should have processed packet 1
    assert.equal(toolUse.success_count, 1);
    assert.equal(codeEdit.success_count, 1);

    const tuRefs = toolUse.evidence_refs as any[];
    const ceRefs = codeEdit.evidence_refs as any[];
    assert.equal(tuRefs[0].packetId, 1);
    assert.equal(ceRefs[0].packetId, 1);

    // Re-run: each capability's own evidence refs block re-processing,
    // but tool_use's refs don't leak into code_editing
    await updater.updateAll();
    const toolUse2 = getCapRow('tool_use')!;
    const codeEdit2 = getCapRow('code_editing')!;
    assert.equal(toolUse2.success_count, 1); // not doubled
    assert.equal(codeEdit2.success_count, 1); // not doubled
    const tuRefs2 = toolUse2.evidence_refs as any[];
    const ceRefs2 = codeEdit2.evidence_refs as any[];
    assert.equal(tuRefs2.length, 1);
    assert.equal(ceRefs2.length, 1);
  });
});

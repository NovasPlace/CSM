import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  auditMemoryProvenance,
  buildMemoryProvenanceAuditSql,
} from '../src/memory-provenance-audit.js';

describe('memory provenance audit', () => {
  it('builds PostgreSQL provenance checks with session fallback and active-state accounting', () => {
    const sql = buildMemoryProvenanceAuditSql('pg');

    assert.match(sql, /metadata->>'source_kind'/);
    assert.match(sql, /metadata->>'source_session_id'/);
    assert.match(sql, /session_id/);
    assert.match(sql, /superseded_by IS NULL AND archived_at IS NULL/);
    assert.match(sql, /LOWER\(.+source_model_id/s);
    assert.match(sql, /default_model_id_rows/);
  });

  it('builds SQLite provenance checks with JSON extraction', () => {
    const sql = buildMemoryProvenanceAuditSql('sqlite');

    assert.match(sql, /json_extract\(metadata, '\$\.source_kind'\)/);
    assert.match(sql, /json_extract\(metadata, '\$\.source_session_id'\)/);
    assert.match(sql, /session_id/);
  });

  it('maps database counts without treating string counts as text', async () => {
    let observedSql = '';
    const pool = {
      query: async (sql: string) => {
        observedSql = sql;
        return {
          rows: [{
            total_memories: '60',
            active_memories: '44',
            complete_provenance: '20',
            rows_with_any_gap: '40',
            active_rows_with_any_gap: '26',
            missing_source_kind: '3',
            missing_evidence_strength: '4',
            missing_source_session_id: '5',
            missing_source_agent_id: '6',
            missing_source_model_id: '7',
            missing_source_surface: '8',
            unknown_model_id_rows: '9',
            default_model_id_rows: '21',
            active_unknown_model_id_rows: '2',
            active_default_model_id_rows: '17',
          }],
          rowCount: 1,
        };
      },
    };

    const report = await auditMemoryProvenance(pool as never, 'pg');

    assert.match(observedSql, /FROM memories/);
    assert.equal(report.totalMemories, 60);
    assert.equal(report.activeMemories, 44);
    assert.equal(report.completeProvenance, 20);
    assert.equal(report.rowsWithAnyGap, 40);
    assert.equal(report.activeRowsWithAnyGap, 26);
    assert.deepEqual(report.missingByField, {
      source_kind: 3,
      evidence_strength: 4,
      source_session_id: 5,
      source_agent_id: 6,
      source_model_id: 7,
      source_surface: 8,
    });
    assert.equal(report.unknownModelIdRows, 9);
    assert.equal(report.defaultModelIdRows, 21);
    assert.equal(report.activeUnknownModelIdRows, 2);
    assert.equal(report.activeDefaultModelIdRows, 17);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryManager as BaseMemoryManager } from '../src/memory-manager-base.js';

function makeHarness() {
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT project_id FROM sessions')) {
        return { rows: [{ project_id: 'project-a' }], rowCount: 1 };
      }

      if (sql.includes('INSERT INTO memories') && sql.includes('RETURNING *')) {
        return {
          rows: [{
            id: 201,
            session_id: params[0],
            project_id: params[1],
            memory_type: params[2],
            content: params[3],
            importance: params[4],
            emotion: params[5],
            confidence: params[6],
            source: params[7],
            tags: params[8],
            linked_memory_ids: params[9],
            metadata: params[10],
            created_at: new Date(),
            updated_at: new Date(),
            accessed_at: new Date(),
            access_count: 0,
          }],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 0 };
    },
  };

  const database = {
    dialect: 'pg' as const,
    getPool: () => pool,
  };
  const embeddings = {
    generate: async () => null,
    getProviderInfo: () => ({ provider: 'test', model: 'test' }),
  };

  return new BaseMemoryManager(database as never, embeddings as never);
}

describe('BaseMemoryManager provenance default completion', () => {
  it('fills missing provenance fields when only source_kind is supplied', async () => {
    const memory = await makeHarness().saveMemory({
      sessionId: 'session-a',
      projectId: 'project-a',
      type: 'lesson',
      content: 'Base manager provenance regression coverage',
      source: 'manual',
      metadata: {
        source_kind: 'user_supplied',
        marker: 'preserve-me',
      },
    });

    assert.equal(memory.metadata.source_kind, 'user_supplied');
    assert.equal(memory.metadata.evidence_strength, 'direct_original');
    assert.equal(memory.metadata.source_session_id, 'session-a');
    assert.equal(memory.metadata.source_agent_id, 'opencode');
    assert.equal(memory.metadata.source_model_id, 'unknown');
    assert.equal(memory.metadata.source_surface, 'opencode');
    assert.equal(memory.metadata.marker, 'preserve-me');
  });

  it('preserves caller provenance while filling the remaining fields', async () => {
    const memory = await makeHarness().saveMemory({
      sessionId: 'session-a',
      projectId: 'project-a',
      type: 'lesson',
      content: 'Base manager custom provenance coverage',
      source: 'auto',
      metadata: {
        evidence_strength: 'derived_summary',
        source_agent_id: 'custom-agent',
      },
    });

    assert.equal(memory.metadata.source_kind, 'transcript');
    assert.equal(memory.metadata.evidence_strength, 'derived_summary');
    assert.equal(memory.metadata.source_session_id, 'session-a');
    assert.equal(memory.metadata.source_agent_id, 'custom-agent');
    assert.equal(memory.metadata.source_model_id, 'unknown');
    assert.equal(memory.metadata.source_surface, 'opencode');
  });
});

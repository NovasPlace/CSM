import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryManager } from '../src/memory-manager.js';

function makeHarness() {
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT project_id FROM sessions')) {
        return { rows: [{ project_id: 'project-a' }], rowCount: 1 };
      }

      if (sql.includes('INSERT INTO memories') && sql.includes('RETURNING *')) {
        return {
          rows: [{
            id: 101,
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

  return new MemoryManager(database as never, embeddings as never);
}

async function saveWith(metadata: Record<string, unknown>, source: 'manual' | 'auto' = 'manual') {
  const manager = makeHarness();
  return manager.saveMemory({
    sessionId: 'session-a',
    projectId: 'project-a',
    type: 'lesson',
    content: 'Governance provenance regression coverage',
    source,
    metadata,
  });
}

describe('MemoryManager provenance default completion', () => {
  it('fills missing provenance fields when only source_kind is supplied', async () => {
    const governance = {
      failure_mode: 'repeat mistake',
      veto_action: 'repeat mistake',
      required_action: 'use verified path',
    };
    const memory = await saveWith({
      source_kind: 'user_supplied',
      governance,
    });

    assert.equal(memory.metadata.source_kind, 'user_supplied');
    assert.equal(memory.metadata.evidence_strength, 'direct_original');
    assert.equal(memory.metadata.source_session_id, 'session-a');
    assert.equal(memory.metadata.source_agent_id, 'opencode');
    assert.equal(memory.metadata.source_model_id, 'default');
    assert.equal(memory.metadata.source_surface, 'opencode');
    assert.deepEqual(memory.metadata.governance, governance);
  });

  it('fills missing provenance fields when only evidence_strength is supplied', async () => {
    const memory = await saveWith({
      evidence_strength: 'direct_original',
      marker: 'preserve-me',
    }, 'auto');

    assert.equal(memory.metadata.source_kind, 'transcript');
    assert.equal(memory.metadata.evidence_strength, 'direct_original');
    assert.equal(memory.metadata.source_session_id, 'session-a');
    assert.equal(memory.metadata.source_agent_id, 'opencode');
    assert.equal(memory.metadata.source_model_id, 'default');
    assert.equal(memory.metadata.source_surface, 'opencode');
    assert.equal(memory.metadata.marker, 'preserve-me');
  });

  it('preserves a complete caller-supplied provenance bundle', async () => {
    const custom = {
      source_kind: 'tool_trace',
      evidence_strength: 'derived_summary',
      source_session_id: 'custom-session',
      source_agent_id: 'custom-agent',
      source_model_id: 'custom-model',
      source_surface: 'custom-surface',
    };
    const memory = await saveWith(custom, 'auto');

    for (const [key, value] of Object.entries(custom)) {
      assert.equal(memory.metadata[key], value);
    }
  });
});

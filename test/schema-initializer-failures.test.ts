import { it } from 'node:test';
import assert from 'node:assert/strict';
import { initializeBeliefKnowledgeSchema } from '../src/belief-knowledge-schema.js';
import { initializeExperiencePacketSchema } from '../src/experience-packet-schema.js';
import { initializeSqliteLivingState } from '../src/schema/sqlite/living-state.js';
import type { DatabasePool } from '../src/types.js';

function poolWithQuery(
  query: DatabasePool['query'],
): DatabasePool {
  return {
    query,
    connect: async () => ({ query, release() {} }),
    end: async () => {},
  };
}

  it('propagates an experience-packet constraint failure', async () => {
    const pool = poolWithQuery(async (sql) => {
      if (sql.includes('ADD CONSTRAINT experience_packets_entry_type_check')) {
        throw new Error('experience constraint rejected');
      }
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      () => initializeExperiencePacketSchema(pool),
      /experience constraint rejected/,
    );
  });

  it('propagates a belief precision migration failure', async () => {
    const pool = poolWithQuery(async (sql) => {
      if (sql.includes('information_schema.columns')) {
        return { rows: [{ data_type: 'real' }], rowCount: 1 };
      }
      if (sql.includes('ALTER COLUMN confidence')) {
        throw new Error('belief precision migration rejected');
      }
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      () => initializeBeliefKnowledgeSchema(pool),
      /belief precision migration rejected/,
    );
  });

  it('propagates a SQLite candidate-column upgrade failure', async () => {
    const pool = poolWithQuery(async (sql) => {
      if (sql.startsWith('PRAGMA table_info')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith('ALTER TABLE memory_candidate_queue')) {
        throw new Error('candidate column upgrade rejected');
      }
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      () => initializeSqliteLivingState(pool),
      /candidate column upgrade rejected/,
    );
  });

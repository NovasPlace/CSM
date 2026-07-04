import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deriveInternalState, deriveNeutralState } from '../dist/internal-state-deriver.js';
import { ExperiencePacketCreator } from '../dist/experience-packet.js';

function makePool() {
  const rows: unknown[] = [];
  return {
    pool: {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('SELECT COUNT(*)')) {
          return Promise.resolve({ rows: [{ cnt: String(rows.length) }], rowCount: 1 });
        }
        if (sql.includes('SELECT') && !sql.includes('COUNT')) {
          return Promise.resolve({ rows: [...rows], rowCount: rows.length });
        }
        if (sql.includes('INSERT')) {
          const row = {
            id: rows.length + 1,
            session_id: _params?.[0] ?? 'test-session',
            project_id: _params?.[1] ?? null,
            entry_type: _params?.[2] ?? 'tool_execution',
            entry_id: null,
            internal_state: _params?.[3] ?? '{}',
            signals: _params?.[4] ?? '{}',
            confidence: _params?.[5] ?? 0.5,
            created_at: new Date().toISOString(),
          };
          rows.push(row);
          return Promise.resolve({ rows: [row], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      getDialect: () => 'pg' as const,
    },
    rows,
  };
}

describe('InternalStateDeriver', () => {
  it('produces neutral state by default', () => {
    const state = deriveInternalState({});
    assert.equal(state.cognitiveLoad, 0.1);
    assert.equal(state.frustration, 0);
    assert.equal(state.energy, 0.8);
    assert.equal(state.dominantEmotion, 'neutral');
    assert.equal(state.stance, 'focused');
    assert.equal(state.urgency, 0);
  });

  it('derives frustration on error', () => {
    const state = deriveInternalState({ error: 'something broke' });
    assert.ok(state.frustration >= 0.4);
    assert.equal(state.dominantEmotion, 'frustration');
    assert.equal(state.stance, 'recovery');
    assert.ok(state.urgency >= 0.5);
  });

  it('derives frustration on non-zero exit code', () => {
    const state = deriveInternalState({ exitCode: 1 });
    assert.ok(state.frustration >= 0.25);
    assert.equal(state.dominantEmotion, 'frustration');
    assert.equal(state.stance, 'recovery');
  });

  it('detects loop state', () => {
    const state = deriveInternalState({ loopDetected: true });
    assert.ok(state.frustration >= 0.6);
    assert.equal(state.dominantEmotion, 'frustration');
    assert.equal(state.stance, 'stuck');
    assert.ok(state.urgency >= 0.7);
  });

  it('maps read tool to exploratory stance', () => {
    const state = deriveInternalState({ toolName: 'read' });
    assert.equal(state.stance, 'exploratory');
    assert.equal(state.dominantEmotion, 'curiosity');
  });

  it('maps write tool to focused stance', () => {
    const state = deriveInternalState({ toolName: 'write' });
    assert.equal(state.stance, 'focused');
    assert.equal(state.dominantEmotion, 'curiosity');
  });

  it('boosts energy on milestone intent', () => {
    const state = deriveInternalState({ intent: 'completed the feature' });
    assert.equal(state.dominantEmotion, 'success');
    assert.ok(state.energy >= 0.8);
    assert.ok(state.frustration <= 0.5);
  });

  it('merges with previous state', () => {
    const prev = deriveInternalState({ error: 'fail1' });
    const next = deriveInternalState({ toolName: 'read', recentErrors: 1 }, prev);
    assert.ok(next.frustration > 0);
  });

  it('deriveNeutralState returns defaults', () => {
    const state = deriveNeutralState();
    assert.equal(state.cognitiveLoad, 0.1);
    assert.equal(state.frustration, 0);
    assert.equal(state.energy, 0.8);
    assert.equal(state.dominantEmotion, 'neutral');
    assert.equal(state.stance, 'exploratory');
    assert.equal(state.urgency, 0);
  });

  it('clamps values to 0-1 range', () => {
    const high = deriveInternalState({ recentErrors: 100 });
    assert.ok(high.frustration <= 1);
    assert.ok(high.cognitiveLoad <= 1);
    assert.ok(high.urgency <= 1);
    assert.ok(high.energy >= 0);
  });
});

describe('ExperiencePacketCreator', () => {
  it('creates a tool packet and writes to DB', async () => {
    const { pool, rows } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordToolPacket({
      sessionId: 'sess-1',
      projectId: 'proj-1',
      toolName: 'read',
    });

    assert.ok(packet.id);
    assert.equal(packet.entryType, 'tool_execution');
    assert.equal(packet.sessionId, 'sess-1');
    assert.equal(packet.internalState.stance, 'exploratory');
    assert.equal(rows.length, 1);
  });

  it('creates error-type packet when error present', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordToolPacket({
      sessionId: 'sess-1',
      toolName: 'bash',
      error: 'command not found',
      exitCode: 127,
    });

    assert.equal(packet.entryType, 'error');
    assert.ok(packet.internalState.frustration >= 0.4);
    assert.ok(packet.confidence >= 0.8);
  });

  it('creates milestone packet', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordMilestonePacket({
      sessionId: 'sess-1',
      intent: 'all tests pass',
    });

    assert.equal(packet.entryType, 'milestone');
    assert.equal(packet.internalState.dominantEmotion, 'success');
  });

  it('creates decision packet', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordDecisionPacket({
      sessionId: 'sess-1',
      intent: 'refactor the module',
    });

    assert.equal(packet.entryType, 'decision');
  });

  it('creates session start packet', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordSessionStartPacket({
      sessionId: 'sess-1',
    });

    assert.equal(packet.entryType, 'session_start');
    assert.equal(packet.internalState.dominantEmotion, 'neutral');
  });

  it('creates session end packet', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordSessionEndPacket({
      sessionId: 'sess-1',
      messageCount: 42,
    });

    assert.equal(packet.entryType, 'session_end');
    assert.deepEqual(packet.signals, { messageCount: 42 });
  });

  it('creates loop signal packet', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordLoopSignalPacket({
      sessionId: 'sess-1',
      toolName: 'bash',
      callCount: 5,
    });

    assert.equal(packet.entryType, 'loop_signal');
    assert.equal(packet.internalState.stance, 'stuck');
    assert.ok(packet.internalState.frustration >= 0.6);
  });

  it('getRecentPackets returns empty when no packets', async () => {
    const { pool } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    const packets = await creator.getRecentPackets(10);
    assert.equal(packets.length, 0);
  });

  it('getRecentPackets returns inserted packets', async () => {
    const { pool, rows } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    await creator.recordToolPacket({ sessionId: 'sess-1', toolName: 'read' });
    await creator.recordToolPacket({ sessionId: 'sess-1', toolName: 'write' });

    const packets = await creator.getRecentPackets(10);
    assert.equal(packets.length, 2);
    assert.ok(packets[0].id);
    assert.equal(packets[0].sessionId, 'sess-1');
  });

  it('countAll returns total packet count', async () => {
    const { pool, rows } = makePool();
    const creator = new ExperiencePacketCreator(pool);

    await creator.recordToolPacket({ sessionId: 'sess-1', toolName: 'read' });
    const count = await creator.countAll();
    assert.equal(count, 1);
  });
});

describe('Packet contract: separation from candidates and memories', () => {
  it('tool event creates a packet but does NOT create a candidate or memory', async () => {
    const inserts: Array<{ sql: string; table: string }> = [];
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('INSERT INTO experience_packets')) {
          inserts.push({ sql, table: 'experience_packets' });
          return Promise.resolve({
            rows: [{
              id: 1,
              session_id: 'sess-contract',
              project_id: null,
              entry_type: 'tool_execution',
              entry_id: null,
              internal_state: '{}',
              signals: '{}',
              confidence: 0.6,
              created_at: new Date().toISOString(),
            }],
            rowCount: 1,
          });
        }
        if (sql.includes('INSERT INTO')) {
          inserts.push({ sql, table: sql.match(/INSERT INTO (\w+)/)?.[1] ?? 'unknown' });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      getDialect: () => 'pg' as const,
    };
    const creator = new ExperiencePacketCreator(pool);

    await creator.recordToolPacket({
      sessionId: 'sess-contract',
      toolName: 'bash',
      args: { command: 'npm test' },
      exitCode: 0,
    });

    const packetTables = inserts.filter(i => i.table === 'experience_packets');
    const nonPacketInserts = inserts.filter(i => i.table !== 'experience_packets');

    assert.equal(packetTables.length, 1, 'should insert one experience packet');
    assert.equal(nonPacketInserts.length, 0, 'should NOT insert into any other table');
    assert.equal(inserts.length, 1, 'exactly one INSERT total');
  });

  it('error event creates an error-type packet, never a memory or candidate', async () => {
    const otherInserts: string[] = [];
    const pool = {
      query: mock.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes('INSERT INTO experience_packets')) {
          return Promise.resolve({
            rows: [{
              id: 2,
              session_id: 'sess-contract',
              project_id: null,
              entry_type: 'error',
              entry_id: null,
              internal_state: '{}',
              signals: '{}',
              confidence: 0.8,
              created_at: new Date().toISOString(),
            }],
            rowCount: 1,
          });
        }
        if (sql.includes('INSERT INTO')) {
          const table = sql.match(/INSERT INTO (\w+)/)?.[1] ?? 'unknown';
          otherInserts.push(table);
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }),
      getDialect: () => 'pg' as const,
    };
    const creator = new ExperiencePacketCreator(pool);

    const packet = await creator.recordToolPacket({
      sessionId: 'sess-contract',
      toolName: 'bash',
      error: 'command not found',
      exitCode: 127,
    });

    assert.equal(packet.entryType, 'error');
    assert.equal(otherInserts.length, 0, 'no inserts into candidates/memories tables');
  });
});

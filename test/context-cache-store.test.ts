/**
 * Phase 6 — Context Cache Store DB-integration tests.
 * Runs against REAL PostgreSQL (no mocks) per ruleset Section 8.
 * DB: postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory
 */

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { Pool } from 'pg';
import { initializeContextCacheSchema } from '../dist/context-cache-schema.js';
import {
  storeItem, fetchItem, searchItems, fetchFileReads,
  fetchLastError, fetchDecisions, countItems, pruneOldItems,
  type CacheItemInput, type CacheKind,
} from '../dist/context-cache-store.js';

const DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const SID = 'test-cache-store-' + Date.now();
const pool = new Pool({ connectionString: DB_URL }) as any;

function mkItem(over: Partial<CacheItemInput> & { displayId: string; kind: CacheKind }): CacheItemInput {
  return {
    sessionId: over.sessionId ?? SID,
    displayId: over.displayId,
    kind: over.kind,
    createdAt: over.createdAt ?? Date.now(),
    summary: over.summary ?? 'test summary',
    content: over.content ?? 'test content body',
    metadata: over.metadata ?? {},
    tokens: over.tokens ?? 50,
    messageIndex: over.messageIndex,
  };
}

describe('Phase 6 — Context Cache Store (real DB)', () => {

  before(async () => { await initializeContextCacheSchema(pool); });
  after(async () => {
    await pool.query('DELETE FROM context_cache WHERE session_id = $1', [SID]);
    await pool.end();
  });

  it('storeItem + fetchItem round-trips all fields including JSONB metadata', async () => {
    const input = mkItem({
      displayId: 'turn_1_0', kind: 'turn',
      summary: 'assistant said something important here',
      content: 'full text of the assistant turn',
      metadata: { foo: 'bar', nested: { x: 1 } },
      tokens: 42, messageIndex: 1,
    });
    await storeItem(pool, input);
    const got = await fetchItem(pool, SID, 'turn_1_0');
    ok(got !== null, 'fetchItem must return the stored item');
    strictEqual(got!.sessionId, SID);
    strictEqual(got!.displayId, 'turn_1_0');
    strictEqual(got!.kind, 'turn');
    strictEqual(got!.summary, input.summary);
    strictEqual(got!.content, input.content);
    strictEqual(got!.tokens, 42);
    strictEqual(got!.messageIndex, 1);
    deepStrictEqual(got!.metadata, { foo: 'bar', nested: { x: 1 } });
  });

  it('storeItem ON CONFLICT does not duplicate', async () => {
    await storeItem(pool, mkItem({ displayId: 'turn_2_0', kind: 'turn' }));
    await storeItem(pool, mkItem({ displayId: 'turn_2_0', kind: 'turn' }));
    const c = await countItems(pool, SID);
    ok(c >= 1, 'at least the one item exists');
    // countItems counts ALL items for this session; verify no duplicate for this id
    const res = await pool.query(
      'SELECT COUNT(*)::int AS c FROM context_cache WHERE session_id=$1 AND display_id=$2',
      [SID, 'turn_2_0'],
    );
    strictEqual(res.rows[0].c, 1);
  });

  it('fetchItem returns null on miss', async () => {
    const got = await fetchItem(pool, SID, 'nonexistent_id');
    strictEqual(got, null);
  });

  it('fetchItem increments fetch_count on each call', async () => {
    await storeItem(pool, mkItem({ displayId: 'turn_3_0', kind: 'turn' }));
    await fetchItem(pool, SID, 'turn_3_0');
    const got = await fetchItem(pool, SID, 'turn_3_0');
    ok(got !== null);
    strictEqual(got!.fetchCount, 2);
  });

  it('searchItems matches on summary and content, returns empty on miss', async () => {
    await storeItem(pool, mkItem({
      displayId: 'turn_4_0', kind: 'turn',
      summary: 'unique banana keyword here',
      content: 'some content',
    }));
    const matches = await searchItems(pool, SID, 'banana', 10);
    ok(matches.length >= 1);
    ok(matches.some((m) => m.displayId === 'turn_4_0'));
    const none = await searchItems(pool, SID, 'zzznomatchxyz', 10);
    strictEqual(none.length, 0);
  });

  it('fetchFileReads filters by metadata.filePath', async () => {
    await storeItem(pool, mkItem({
      displayId: 'file_5_0', kind: 'file_read',
      summary: 'read /src/foo.ts',
      metadata: { filePath: '/src/foo.ts', tool: 'read' },
    }));
    const got = await fetchFileReads(pool, SID, '/src/foo.ts');
    ok(got.length >= 1);
    ok(got.some((m) => m.displayId === 'file_5_0' && m.kind === 'file_read'));
    const none = await fetchFileReads(pool, SID, '/nonexistent.ts');
    strictEqual(none.length, 0);
  });

  it('fetchLastError returns latest error or null', async () => {
    await storeItem(pool, mkItem({
      displayId: 'error_6_0', kind: 'error',
      summary: 'error in bash: boom',
      createdAt: Date.now() - 1000,
    }));
    await storeItem(pool, mkItem({
      displayId: 'error_6_1', kind: 'error',
      summary: 'error in bash: later boom',
      createdAt: Date.now(),
    }));
    const got = await fetchLastError(pool, SID);
    ok(got !== null);
    strictEqual(got!.kind, 'error');
    strictEqual(got!.displayId, 'error_6_1');
  });

  it('fetchDecisions returns decisions ordered DESC by created_at', async () => {
    await storeItem(pool, mkItem({
      displayId: 'dec_7_0', kind: 'decision',
      summary: 'chose option A', createdAt: Date.now() - 2000,
    }));
    await storeItem(pool, mkItem({
      displayId: 'dec_7_1', kind: 'decision',
      summary: 'chose option B', createdAt: Date.now(),
    }));
    const got = await fetchDecisions(pool, SID, 10);
    ok(got.length >= 2);
    strictEqual(got[0].displayId, 'dec_7_1');
    strictEqual(got[1].displayId, 'dec_7_0');
  });

  it('pruneOldItems removes oldest beyond maxItems', async () => {
    const psid = SID + '-prune';
    for (let i = 0; i < 3; i++) {
      await storeItem(pool, mkItem({
        displayId: `prune_${i}`, kind: 'turn',
        createdAt: Date.now() + i, sessionId: psid,
      }));
    }
    const deleted = await pruneOldItems(pool, psid, 2);
    strictEqual(deleted, 1);
    const remaining = await countItems(pool, psid);
    strictEqual(remaining, 2);
    await pool.query('DELETE FROM context_cache WHERE session_id = $1', [psid]);
  });

});

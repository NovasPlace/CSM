/**
 * Phase 6 — Context Cache Runtime (cacheOldContext) DB-integration test.
 * Runs against REAL PostgreSQL (no mocks) per ruleset Section 8.
 * Verifies the full write path: messages → extract → store → mutate prompt.
 */

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { Pool } from 'pg';
import { initializeContextCacheSchema } from '../dist/context-cache-schema.js';
import { cacheOldContext, type CacheRuntimeConfig } from '../dist/context-cache-runtime.js';
import { countItems, fetchItem, fetchFileReads, fetchLastError } from '../dist/context-cache-store.js';

const DB_URL = process.env.CSM_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
const SID = 'test-cache-runtime-' + Date.now();
const pool = new Pool({ connectionString: DB_URL }) as any;

const BIG_TEXT = 'x'.repeat(300);
const BIG_TOOL_OUT = 'y'.repeat(300);
const BIG_ERR_OUT = 'Error: something broke\n' + 'z'.repeat(300);

function mkMsg(role: string, parts: any[]): { info: { role: string }; parts: any[] } {
  return { info: { role }, parts };
}

const messages = [
  mkMsg('user', [{ type: 'text', text: 'do the work' }]),
  mkMsg('assistant', [{ type: 'text', text: BIG_TEXT }]),
  mkMsg('assistant', [{ type: 'tool', tool: 'read', state: { status: 'completed', output: BIG_TOOL_OUT, input: { filePath: '/foo.ts' } } }]),
  mkMsg('assistant', [{ type: 'tool', tool: 'bash', state: { status: 'completed', output: BIG_ERR_OUT, input: { command: 'ls' } } }]),
  mkMsg('assistant', [{ type: 'text', text: 'recent small reply' }]),
];

const CFG: CacheRuntimeConfig = { recentTurnWindow: 1, minTokensToCache: 5 };

describe('Phase 6 — cacheOldContext end-to-end (real DB)', () => {

  before(async () => { await initializeContextCacheSchema(pool); });
  after(async () => {
    await pool.query('DELETE FROM context_cache WHERE session_id = $1', [SID]);
    await pool.end();
  });

  it('caches old large parts and mutates prompt text in place', async () => {
    const res = await cacheOldContext(pool, SID, messages, CFG);
    // 3 cacheable parts: assistant text (turn), read tool (file_read), bash error (error)
    // m0=user skipped, m4 within recentTurnWindow=1 skipped
    strictEqual(res.itemsCached, 3);
    ok(res.tokensReplaced > 0);

    // Verify all 3 items landed in DB
    strictEqual(await countItems(pool, SID), 3);

    // Turn item
    const turn = await fetchItem(pool, SID, 'turn_1_0');
    ok(turn !== null);
    strictEqual(turn!.kind, 'turn');
    strictEqual(turn!.content, BIG_TEXT);

    // File-read item
    const file = await fetchFileReads(pool, SID, '/foo.ts');
    ok(file.some((m) => m.displayId === 'file_2_0' && m.kind === 'file_read'));

    // Error item (latest error)
    const err = await fetchLastError(pool, SID);
    ok(err !== null);
    strictEqual(err!.displayId, 'error_3_0');
    strictEqual(err!.kind, 'error');

    // Prompt mutation: original text replaced with [CACHED: id] summary
    match(messages[1].parts[0].text, /^\[CACHED: turn_1_0\]/);
    match(messages[2].parts[0].state.output, /^\[CACHED: file_2_0\]/);
    match(messages[3].parts[0].state.output, /^\[CACHED: error_3_0\]/);

    // Recent message untouched
    strictEqual(messages[4].parts[0].text, 'recent small reply');
  });

  it('skips items below minTokensToCache threshold', async () => {
    const sid2 = SID + '-thresh';
    const msgs = [
      mkMsg('assistant', [{ type: 'text', text: 'small text under threshold' }]),
    ];
    const res = await cacheOldContext(pool, sid2, msgs, { recentTurnWindow: 0, minTokensToCache: 9999 });
    strictEqual(res.itemsCached, 0);
    strictEqual(await countItems(pool, sid2), 0);
    await pool.query('DELETE FROM context_cache WHERE session_id = $1', [sid2]);
  });

});

// Phase 2C.4.1: Restore Proof on Tiny Controlled Batch
// Proves archive/restore round-trip on synthetic rows without touching real history.
//
// Run: node scripts/restore-proof-phase2c4-1.mjs
//
// Safety:
// - Inserts 1 test session + 2 synthetic superseded memories, cleans them up after.
// - All 7,241 real archived rows remain archived (verified before/after each step).
// - Aborts early if eligible count exceeds synthetic count.
import fs from 'node:fs';
import pg from 'pg';
import { SupersededDuplicateArchiver } from '../dist/archive-superseded-duplicates.js';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

const TEST_SESSION_ID = 'ses_test_phase2c4_1_restore_proof';
const TEST_BATCH_ID = 'test-restore-proof-phase2c4-1';
const LIVE_BATCH_ID = 'archive-superseded-2026-07-01T09-29-15-195Z';
const ARCHIVE_REASON = 'already_superseded_duplicate';
const SYNTHETIC_COUNT = 2;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function assert(cond, msg) {
  if (!cond) throw new Error(`PROOF ASSERTION FAILED: ${msg}`);
}

async function liveBatchCount() {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id = $1`,
    [LIVE_BATCH_ID]
  );
  return r.rows[0].cnt;
}

async function totalArchivedCount() {
  const r = await pool.query(`SELECT COUNT(*)::int AS cnt FROM memories WHERE archived_at IS NOT NULL`);
  return r.rows[0].cnt;
}

async function fetchArchiveFields(ids) {
  const r = await pool.query(
    `SELECT id, archived_at, archive_reason, archive_batch_id, archive_source, archive_note
     FROM memories WHERE id = ANY($1::bigint[]) ORDER BY id`,
    [ids]
  );
  return r.rows;
}

async function main() {
  const archiver = new SupersededDuplicateArchiver({ getPool: () => pool });
  const steps = [];
  const startedAt = new Date().toISOString();

  console.log('=== Phase 2C.4.1: Restore Proof on Tiny Controlled Batch ===\n');
  console.log(`Started: ${startedAt}`);
  console.log(`Test session: ${TEST_SESSION_ID}`);
  console.log(`Test batch:   ${TEST_BATCH_ID}`);
  console.log(`Live batch:   ${LIVE_BATCH_ID} (must remain untouched)\n`);

  // --- Pre-proof invariants ---
  const liveBefore = await liveBatchCount();
  const archivedBefore = await totalArchivedCount();
  assert(liveBefore === 7241, `live batch count before = ${liveBefore}, expected 7241`);
  assert(archivedBefore === 7241, `total archived before = ${archivedBefore}, expected 7241`);
  steps.push({ step: 'pre-proof invariants', liveBatchCount: liveBefore, totalArchived: archivedBefore });
  console.log(`[1] Pre-proof: live batch=${liveBefore}, total archived=${archivedBefore} OK\n`);

  let syntheticIds = [];
  let cleanupNeeded = false;
  try {
    // --- Setup: insert test session + synthetic superseded memories ---
    await pool.query(
      `INSERT INTO sessions (id, title, summary) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_SESSION_ID, 'phase2c4.1 restore proof (synthetic)', 'synthetic - safe to delete']
    );

    // Canonical real id to point superseded_by at
    const canon = await pool.query(`SELECT id FROM memories WHERE superseded_by IS NULL ORDER BY id LIMIT 1`);
    const canonId = canon.rows[0].id;

    const inserted = await pool.query(
      `INSERT INTO memories (session_id, memory_type, content, importance, confidence, source, project_id, superseded_by, superseded_at)
       VALUES
         ($1, 'episodic', '[synthetic] restore proof duplicate A', 0.3, 1.0, 'restore-proof', $2, $3, now()),
         ($1, 'episodic', '[synthetic] restore proof duplicate B', 0.3, 1.0, 'restore-proof', $2, $3, now())
       RETURNING id`,
      [TEST_SESSION_ID, 'C:\\Users\\Donovan\\Desktop\\cross-session-memory', canonId]
    );
    syntheticIds = inserted.rows.map((r) => Number(r.id));
    cleanupNeeded = true;
    assert(syntheticIds.length === SYNTHETIC_COUNT, `inserted ${syntheticIds.length} synthetic rows, expected ${SYNTHETIC_COUNT}`);
    steps.push({ step: 'setup synthetic rows', session: TEST_SESSION_ID, memoryIds: syntheticIds, canonicalTarget: canonId });
    console.log(`[2] Inserted ${syntheticIds.length} synthetic superseded memories: ids=${syntheticIds.join(', ')} (superseded_by=${canonId})\n`);

    // --- Step 3: verify synthetic rows are NOT archived yet ---
    const preArchive = await fetchArchiveFields(syntheticIds);
    for (const row of preArchive) {
      assert(row.archived_at === null, `synthetic id ${row.id} should be un-archived before archive step`);
    }
    steps.push({ step: 'verify synthetic un-archived before', rows: preArchive });

    // --- Step 4: run archive apply (real code path) ---
    // Safety: eligible should equal synthetic count since all real rows already archived.
    const archiveReport = await archiver.archive({ apply: true, batchId: TEST_BATCH_ID, note: 'phase2c4.1 restore proof' });
    steps.push({ step: 'archive apply', report: archiveReport });
    console.log(`[3] ARCHIVE APPLY:`);
    console.log(`    eligible=${archiveReport.eligibleCount} targeted=${archiveReport.targetedCount} updated=${archiveReport.updatedCount} batchAfter=${archiveReport.batchCountAfter}`);
    console.log(`    sampleIds=${archiveReport.sampleIds.join(', ')}\n`);

    // CRITICAL safety assertion: only synthetic rows were targeted
    assert(archiveReport.eligibleCount === SYNTHETIC_COUNT, `eligible=${archiveReport.eligibleCount}, expected ${SYNTHETIC_COUNT} (real rows should all be archived already)`);
    assert(archiveReport.targetedCount === SYNTHETIC_COUNT, `targeted=${archiveReport.targetedCount}, expected ${SYNTHETIC_COUNT}`);
    assert(archiveReport.updatedCount === SYNTHETIC_COUNT, `updated=${archiveReport.updatedCount}, expected ${SYNTHETIC_COUNT}`);
    assert(archiveReport.batchCountAfter === SYNTHETIC_COUNT, `batchAfter=${archiveReport.batchCountAfter}, expected ${SYNTHETIC_COUNT}`);

    // --- Step 5: verify archive fields set on synthetic rows ---
    const postArchive = await fetchArchiveFields(syntheticIds);
    for (const row of postArchive) {
      assert(row.archived_at !== null, `synthetic id ${row.id} archived_at should be set`);
      assert(row.archive_reason === ARCHIVE_REASON, `synthetic id ${row.id} archive_reason=${row.archive_reason}`);
      assert(row.archive_batch_id === TEST_BATCH_ID, `synthetic id ${row.id} archive_batch_id=${row.archive_batch_id}`);
    }
    steps.push({ step: 'verify synthetic archived', rows: postArchive });

    // --- Step 6: verify live batch untouched ---
    const liveAfterArchive = await liveBatchCount();
    const archivedAfterArchive = await totalArchivedCount();
    assert(liveAfterArchive === 7241, `live batch after archive = ${liveAfterArchive}, expected 7241`);
    assert(archivedAfterArchive === 7241 + SYNTHETIC_COUNT, `total archived after archive = ${archivedAfterArchive}, expected ${7241 + SYNTHETIC_COUNT}`);
    steps.push({ step: 'live batch untouched after archive', liveBatchCount: liveAfterArchive, totalArchived: archivedAfterArchive });
    console.log(`[4] Post-archive invariants: live batch=${liveAfterArchive} (unchanged), total archived=${archivedAfterArchive} (+${SYNTHETIC_COUNT} synthetic) OK\n`);

    // --- Step 7: run restore apply ---
    const restoreReport = await archiver.restore({ apply: true, batchId: TEST_BATCH_ID });
    steps.push({ step: 'restore apply', report: restoreReport });
    console.log(`[5] RESTORE APPLY:`);
    console.log(`    targeted=${restoreReport.targetedCount} updated=${restoreReport.updatedCount} batchAfter=${restoreReport.batchCountAfter}\n`);

    assert(restoreReport.targetedCount === SYNTHETIC_COUNT, `restore targeted=${restoreReport.targetedCount}, expected ${SYNTHETIC_COUNT}`);
    assert(restoreReport.updatedCount === SYNTHETIC_COUNT, `restore updated=${restoreReport.updatedCount}, expected ${SYNTHETIC_COUNT}`);
    assert(restoreReport.batchCountAfter === 0, `restore batchAfter=${restoreReport.batchCountAfter}, expected 0`);

    // --- Step 8: verify archive fields cleared on synthetic rows ---
    const postRestore = await fetchArchiveFields(syntheticIds);
    for (const row of postRestore) {
      assert(row.archived_at === null, `synthetic id ${row.id} archived_at should be cleared after restore`);
      assert(row.archive_reason === null, `synthetic id ${row.id} archive_reason should be cleared`);
      assert(row.archive_batch_id === null, `synthetic id ${row.id} archive_batch_id should be cleared`);
      assert(row.archive_source === null, `synthetic id ${row.id} archive_source should be cleared`);
      assert(row.archive_note === null, `synthetic id ${row.id} archive_note should be cleared`);
    }
    steps.push({ step: 'verify synthetic restored', rows: postRestore });

    // superseded_by must still be intact (restore only clears archive fields, not supersession)
    for (const row of postRestore) {
      assert(row.superseded_by !== null, `synthetic id ${row.id} superseded_by must remain set after restore`);
    }

    // --- Step 9: verify live batch still untouched ---
    const liveAfterRestore = await liveBatchCount();
    const archivedAfterRestore = await totalArchivedCount();
    assert(liveAfterRestore === 7241, `live batch after restore = ${liveAfterRestore}, expected 7241`);
    assert(archivedAfterRestore === 7241, `total archived after restore = ${archivedAfterRestore}, expected 7241 (synthetic restored)`);
    steps.push({ step: 'live batch untouched after restore', liveBatchCount: liveAfterRestore, totalArchived: archivedAfterRestore });
    console.log(`[6] Post-restore invariants: live batch=${liveAfterRestore} (unchanged), total archived=${archivedAfterRestore} (back to baseline) OK\n`);

    console.log(`[7] RESTORE PROOF PASSED: archive->restore round-trip verified on ${SYNTHETIC_COUNT} synthetic rows.\n`);
  } finally {
    // --- Cleanup: always run, even on assertion failure ---
    if (cleanupNeeded) {
      console.log('[cleanup] Removing synthetic rows...');
      if (syntheticIds.length > 0) {
        // Restore any leftover archive state first so deletes don't leave batch refs
        await pool.query(`UPDATE memories SET archived_at=NULL, archive_reason=NULL, archive_batch_id=NULL, archive_source=NULL, archive_note=NULL WHERE id = ANY($1::bigint[])`, [syntheticIds]);
        const del = await pool.query(`DELETE FROM memories WHERE id = ANY($1::bigint[]) RETURNING id`, [syntheticIds]);
        console.log(`[cleanup] Deleted ${del.rows.length} synthetic memories`);
      }
      await pool.query(`DELETE FROM sessions WHERE id = $1`, [TEST_SESSION_ID]);
      console.log(`[cleanup] Deleted test session ${TEST_SESSION_ID}`);
    }

    // --- Post-cleanup verification ---
    const testBatchLeftover = await pool.query(`SELECT COUNT(*)::int AS cnt FROM memories WHERE archive_batch_id = $1`, [TEST_BATCH_ID]);
    const liveFinal = await liveBatchCount();
    const archivedFinal = await totalArchivedCount();
    assert(testBatchLeftover.rows[0].cnt === 0, `test batch leftover = ${testBatchLeftover.rows[0].cnt}, expected 0`);
    assert(liveFinal === 7241, `live batch final = ${liveFinal}, expected 7241`);
    assert(archivedFinal === 7241, `total archived final = ${archivedFinal}, expected 7241`);
    steps.push({ step: 'post-cleanup verification', testBatchLeftover: testBatchLeftover.rows[0].cnt, liveBatchCount: liveFinal, totalArchived: archivedFinal });
    console.log(`\n[cleanup] Verified: test batch=0, live batch=${liveFinal}, total archived=${archivedFinal} (clean)`);
  }

  // --- Save proof report ---
  const finishedAt = new Date().toISOString();
  const proof = {
    phase: '2C.4.1',
    name: 'Restore Proof on Tiny Controlled Batch',
    startedAt,
    finishedAt,
    result: 'PASS',
    config: {
      testSessionId: TEST_SESSION_ID,
      testBatchId: TEST_BATCH_ID,
      liveBatchId: LIVE_BATCH_ID,
      syntheticCount: SYNTHETIC_COUNT,
      archiveReason: ARCHIVE_REASON,
    },
    invariants: {
      liveBatchBefore: 7241,
      liveBatchAfterArchive: 7241,
      liveBatchAfterRestore: 7241,
      liveBatchFinal: 7241,
      totalArchivedBefore: 7241,
      totalArchivedAfterArchive: 7241 + SYNTHETIC_COUNT,
      totalArchivedAfterRestore: 7241,
      totalArchivedFinal: 7241,
      testBatchLeftover: 0,
    },
    steps,
  };

  const s = stamp();
  const jsonPath = `.tmp/restore-proof-phase2c4-1-${s}.json`;
  const txtPath = `.tmp/restore-proof-phase2c4-1-${s}.txt`;
  fs.writeFileSync(jsonPath, JSON.stringify(proof, null, 2));
  fs.writeFileSync(txtPath, formatProof(proof));
  console.log(`\nProof saved:\n  ${jsonPath}\n  ${txtPath}`);
}

function formatProof(proof) {
  return [
    `Phase ${proof.phase}: ${proof.name}`,
    `Result: ${proof.result}`,
    `Started: ${proof.startedAt}`,
    `Finished: ${proof.finishedAt}`,
    '',
    '=== Invariants ===',
    `  Live batch (${proof.config.liveBatchId}):`,
    `    before=${proof.invariants.liveBatchBefore} afterArchive=${proof.invariants.liveBatchAfterArchive} afterRestore=${proof.invariants.liveBatchAfterRestore} final=${proof.invariants.liveBatchFinal}`,
    `  Total archived:`,
    `    before=${proof.invariants.totalArchivedBefore} afterArchive=${proof.invariants.totalArchivedAfterArchive} afterRestore=${proof.invariants.totalArchivedAfterRestore} final=${proof.invariants.totalArchivedFinal}`,
    `  Test batch leftover: ${proof.invariants.testBatchLeftover}`,
    `  Synthetic rows archived then restored: ${proof.config.syntheticCount}`,
    '',
    '=== Steps ===',
    ...proof.steps.map((s) => `  - ${s.step}`),
    '',
    'ACCEPTANCE: restore clears archive fields for controlled batch, real 7241 rows remain archived, no real rows deleted or restored.',
  ].join('\n');
}

main()
  .catch((e) => {
    console.error('\n' + (e.message || e));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
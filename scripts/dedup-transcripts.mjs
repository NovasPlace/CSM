// One-off: count and delete duplicate transcript memories, keeping the
// earliest (lowest id) per (session_id, messageId).
//
// Run: node scripts/dedup-transcripts.mjs           (dry run, default)
//      node scripts/dedup-transcripts.mjs --apply   (actually delete)
import pg from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const APPLY = process.argv.includes('--apply');

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
pool.on('error', () => {});

async function main() {
  const totalBefore = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM memories`)
  ).rows[0].n;
  const transcriptBefore = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM memories
       WHERE memory_type = 'conversation' AND metadata ? 'fullTranscript'`,
    )
  ).rows[0].n;

  // Find duplicates: groups with > 1 row per (session_id, messageId) where
  // messageId is present. NULL/missing messageId rows are not deduped.
  const dupReport = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE dup_count > 1) AS groups_with_dups,
        SUM(dup_count) FILTER (WHERE dup_count > 1) AS rows_in_dup_groups,
        SUM(dup_count - 1) FILTER (WHERE dup_count > 1) AS rows_to_delete
     FROM (
       SELECT session_id, metadata->>'messageId' AS msg_id, COUNT(*) AS dup_count
       FROM memories
       WHERE memory_type = 'conversation'
         AND metadata ? 'fullTranscript'
         AND metadata->>'messageId' IS NOT NULL
       GROUP BY session_id, metadata->>'messageId'
     ) g`,
  );
  const r = dupReport.rows[0];
  console.log('=== Transcript dedup report ===');
  console.log('Total memories:                 ', totalBefore);
  console.log('Transcript memories:            ', transcriptBefore);
  console.log('Duplicate groups (>1 per msg):  ', r.groups_with_dups ?? 0);
  console.log('Rows in those duplicate groups: ', r.rows_in_dup_groups ?? 0);
  console.log('Rows to delete (keep earliest): ', r.rows_to_delete ?? 0);
  console.log('Mode:', APPLY ? 'APPLY (will delete)' : 'DRY RUN (no deletes)');

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to delete.');
    return;
  }

  if ((r.rows_to_delete ?? 0) === 0) {
    console.log('\nNo duplicates to delete.');
    return;
  }

  // Delete in batches to keep transactions small and memory_chunks cleanup tidy.
  // memory_chunks has ON DELETE CASCADE via memory_id FK, so chunk rows go too.
  const client = await pool.connect();
  try {
    let totalDeleted = 0;
    let batch = 1;
    while (true) {
      await client.query('BEGIN');
      const toDelete = await client.query(
        `DELETE FROM memories
         WHERE id IN (
           SELECT id FROM (
             SELECT id,
                    ROW_NUMBER() OVER (
                      PARTITION BY session_id, metadata->>'messageId'
                      ORDER BY id ASC
                    ) AS rn
             FROM memories
             WHERE memory_type = 'conversation'
               AND metadata ? 'fullTranscript'
               AND metadata->>'messageId' IS NOT NULL
           ) s
           WHERE rn > 1
         )
         RETURNING id`,
      );
      const deleted = toDelete.rowCount ?? 0;
      await client.query('COMMIT');
      totalDeleted += deleted;
      console.log(`Batch ${batch}: deleted ${deleted} rows (cumulative ${totalDeleted})`);
      batch++;
      if (deleted === 0) break;
      if (deleted < 5000) break; // last partial batch
    }
    console.log(`\nDone. Total deleted: ${totalDeleted}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Failed, rolled back:', e);
    process.exitCode = 1;
  } finally {
    client.release();
  }

  const totalAfter = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM memories`)
  ).rows[0].n;
  const transcriptAfter = (
    await pool.query(
      `SELECT COUNT(*)::int AS n FROM memories
       WHERE memory_type = 'conversation' AND metadata ? 'fullTranscript'`,
    )
  ).rows[0].n;
  console.log('After cleanup:');
  console.log('  Total memories:     ', totalAfter);
  console.log('  Transcript memories:', transcriptAfter);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

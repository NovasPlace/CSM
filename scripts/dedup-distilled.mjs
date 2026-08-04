// One-off: count and delete duplicate distilled_summaries, keeping the
// earliest (lowest built_at, then lowest id) per (session_id, compressed).
//
// Two plugin instances running concurrently produced near-identical summaries
// ~50ms apart with different `summary_<Date.now()>` ids. This script collapses
// those pairs.
//
// Run: node scripts/dedup-distilled.mjs           (dry run, default)
//      node scripts/dedup-distilled.mjs --apply   (actually delete)
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
    await pool.query(`SELECT COUNT(*)::int AS n FROM distilled_summaries`)
  ).rows[0].n;

  // Duplicate groups: same session + identical compressed text, built within
  // 2 seconds of each other (same distill call from two instances).
  const dupReport = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE dup_count > 1) AS groups_with_dups,
        SUM(dup_count) FILTER (WHERE dup_count > 1) AS rows_in_dup_groups,
        SUM(dup_count - 1) FILTER (WHERE dup_count > 1) AS rows_to_delete
     FROM (
       SELECT session_id, compressed,
              COUNT(*) AS dup_count
       FROM distilled_summaries
       GROUP BY session_id, compressed
     ) g`,
  );
  const r = dupReport.rows[0];
  console.log('=== Distilled summaries dedup report ===');
  console.log('Total distilled_summaries:       ', totalBefore);
  console.log('Duplicate groups (>1 per content):', r.groups_with_dups ?? 0);
  console.log('Rows in those duplicate groups:  ', r.rows_in_dup_groups ?? 0);
  console.log('Rows to delete (keep earliest):  ', r.rows_to_delete ?? 0);
  console.log('Mode:', APPLY ? 'APPLY (will delete)' : 'DRY RUN (no deletes)');

  if (!APPLY) {
    // Show a sample of the duplicate pairs for confidence.
    const sample = await pool.query(
      `SELECT a.id AS keep_id, b.id AS dup_id,
              a.session_id, a.built_at AS keep_at, b.built_at AS dup_at,
              a.total_calls_summarized AS calls
       FROM distilled_summaries a
       JOIN distilled_summaries b
         ON a.session_id = b.session_id
        AND a.compressed = b.compressed
        AND a.built_at <= b.built_at
        AND a.id <> b.id
        AND EXTRACT(EPOCH FROM (b.built_at - a.built_at)) BETWEEN 0 AND 2
       ORDER BY a.built_at DESC
       LIMIT 10`,
    );
    if (sample.rows.length > 0) {
      console.log('\nSample duplicate pairs (keep → delete):');
      for (const row of sample.rows) {
        const gap = (new Date(row.dup_at) - new Date(row.keep_at));
        console.log(
          `  ${row.keep_id} (keep) | ${row.dup_id} (dup) | gap=${gap}ms | calls=${row.calls}`,
        );
      }
    }
    console.log('\nDry run only — re-run with --apply to delete.');
    return;
  }

  if ((r.rows_to_delete ?? 0) === 0) {
    console.log('\nNo duplicates to delete.');
    return;
  }

  // Delete duplicates: for each (session_id, compressed, second) group, keep
  // the row with the earliest built_at (tiebreak: lowest id), delete the rest.
  const result = await pool.query(
    `DELETE FROM distilled_summaries
     WHERE id IN (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id, compressed
                  ORDER BY built_at ASC, id ASC
                ) AS rn
         FROM distilled_summaries
       ) s
       WHERE rn > 1
     )
     RETURNING id`,
  );
  console.log(`\nDeleted ${result.rowCount ?? 0} duplicate distilled summaries.`);

  const totalAfter = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM distilled_summaries`)
  ).rows[0].n;
  console.log('After cleanup:', totalAfter, 'distilled_summaries remain');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

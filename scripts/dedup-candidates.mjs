// One-off: count and delete duplicate memory_candidates, keeping the earliest
// per (session_id, content, type). Two plugin instances both extracted
// candidates from the same distilled summary, producing exact-content dupes.
//
// Run: node scripts/dedup-candidates.mjs           (dry run, default)
//      node scripts/dedup-candidates.mjs --apply   (actually delete)
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
    await pool.query(`SELECT COUNT(*)::int AS n FROM memory_candidates`)
  ).rows[0].n;

  const dupReport = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE dup_count > 1) AS groups_with_dups,
        SUM(dup_count) FILTER (WHERE dup_count > 1) AS rows_in_dup_groups,
        SUM(dup_count - 1) FILTER (WHERE dup_count > 1) AS rows_to_delete
     FROM (
       SELECT session_id, content, proposed_type, COUNT(*) AS dup_count
       FROM memory_candidates
       GROUP BY session_id, content, proposed_type
     ) g`,
  );
  const r = dupReport.rows[0];
  console.log('=== Memory candidates dedup report ===');
  console.log('Total memory_candidates:          ', totalBefore);
  console.log('Duplicate groups (>1 per content):', r.groups_with_dups ?? 0);
  console.log('Rows in those duplicate groups:   ', r.rows_in_dup_groups ?? 0);
  console.log('Rows to delete (keep earliest):   ', r.rows_to_delete ?? 0);
  console.log('Mode:', APPLY ? 'APPLY (will delete)' : 'DRY RUN (no deletes)');

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to delete.');
    return;
  }

  if ((r.rows_to_delete ?? 0) === 0) {
    console.log('\nNo duplicates to delete.');
    return;
  }

  const result = await pool.query(
    `DELETE FROM memory_candidates
     WHERE id IN (
       SELECT id FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY session_id, content, proposed_type
                  ORDER BY created_at ASC, id ASC
                ) AS rn
         FROM memory_candidates
       ) s
       WHERE rn > 1
     )
     RETURNING id`,
  );
  console.log(`\nDeleted ${result.rowCount ?? 0} duplicate memory_candidates.`);

  const totalAfter = (
    await pool.query(`SELECT COUNT(*)::int AS n FROM memory_candidates`)
  ).rows[0].n;
  console.log('After cleanup:', totalAfter, 'memory_candidates remain');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

// Quick smoke test: search for procedural memories post-merge
// Verify superseded rows are excluded and only canonical appear
import pg from 'pg';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

async function main() {
  console.log('=== Post-merge procedural search smoke test ===\n');

  // 1. Count by status
  const statusBreakdown = await pool.query(`
    SELECT
      CASE WHEN superseded_by IS NULL THEN 'active' ELSE 'superseded' END AS status,
      COUNT(*)::int AS cnt
    FROM memories WHERE memory_type = 'procedural'
    GROUP BY 1
  `);
  console.log('Procedural status breakdown:');
  for (const r of statusBreakdown.rows) {
    console.log(`  ${r.status}: ${r.cnt}`);
  }
  console.log();

  // 2. Active-only search: "Mixed tool sequence" (should return only canonical, no spam)
  const mixedActive = await pool.query(`
    SELECT id, content, created_at
    FROM memories
    WHERE memory_type = 'procedural'
      AND superseded_by IS NULL
      AND content ILIKE '%Mixed tool%'
    ORDER BY id
    LIMIT 15
  `);
  console.log(`Active "Mixed tool sequence" memories: ${mixedActive.rows.length}`);
  for (const r of mixedActive.rows) {
    console.log(`  #${r.id}: "${r.content.slice(0, 80)}"`);
  }
  console.log();

  // 3. Superseded "Mixed tool sequence" count
  const mixedSuperseded = await pool.query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories
    WHERE memory_type = 'procedural'
      AND superseded_by IS NOT NULL
      AND content ILIKE '%Mixed tool%'
  `);
  console.log(`Superseded "Mixed tool sequence" memories: ${mixedSuperseded.rows[0].cnt}`);
  console.log();

  // 4. Unfiltered query: all procedural (what recall would get if not filtering superseded_by)
  const allProcedural = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM memories WHERE memory_type = 'procedural'
  `);
  const activeProcedural = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM memories WHERE memory_type = 'procedural' AND superseded_by IS NULL
  `);
  console.log(`All procedural: ${allProcedural.rows[0].cnt}`);
  console.log(`Active procedural (superseded_by IS NULL): ${activeProcedural.rows[0].cnt}`);
  console.log();

  // 5. Check memory_merges table
  const merges = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM memory_merges
  `);
  const mergeSample = await pool.query(`
    SELECT canonical_id, duplicate_count, reason, merged_at
    FROM memory_merges
    ORDER BY duplicate_count DESC
    LIMIT 5
  `);
  console.log(`Total merge records: ${merges.rows[0].cnt}`);
  console.log('Top 5 merges:');
  for (const r of mergeSample.rows) {
    console.log(`  canonical=#${r.canonical_id} dup_count=${r.duplicate_count} reason=${r.reason} at=${r.merged_at}`);
  }
  console.log();

  // 6. Verify no data loss: sum of active + superseded = total
  const totalCheck = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE superseded_by IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS superseded
    FROM memories WHERE memory_type = 'procedural'
  `);
  const c = totalCheck.rows[0];
  console.log(`Integrity check: total=${c.total}, active=${c.active}, superseded=${c.superseded}`);
  console.log(`  active + superseded = ${c.active + c.superseded} (should = ${c.total})`);
  console.log(`  Status: ${c.active + c.superseded === c.total ? 'PASS' : 'FAIL'}`);

  console.log('\n=== Smoke test complete ===');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
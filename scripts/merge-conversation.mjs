// Phase 2A.2: Apply exact-content merge on conversation memories
// Run: node scripts/merge-conversation.mjs --apply
// Stricter: marks exact-content duplicates as superseded (no deletion)
import pg from 'pg';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const APPLY = process.argv.includes('--apply');
const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

const EXCLUDE_TYPES = ['lesson'];
const MEMORY_TYPE = 'conversation';
const MAX_GROUPS = 200;

async function main() {
  console.log('=== Merge Apply: Conversation memories ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Mode: ${APPLY ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log(`MemoryType: ${MEMORY_TYPE}`);
  console.log(`Exclude: [${EXCLUDE_TYPES.join(', ')}]`);
  console.log(`MaxGroups: ${MAX_GROUPS}`);
  console.log();

  const activeBefore = (await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NULL AND memory_type = ANY($1)',
    [[MEMORY_TYPE]],
  )).rows[0].cnt;

  const totalConversation = (await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM memories WHERE memory_type = $1',
    [MEMORY_TYPE],
  )).rows[0].cnt;

  console.log(`Total conversation memories:  ${totalConversation}`);
  console.log(`Active (superseded_by NULL):  ${activeBefore}`);
  console.log();

  const conditions = [
    'm.superseded_by IS NULL',
    `m.memory_type != ALL($1)`,
    `m.memory_type = ANY($2)`,
  ];
  const params = [EXCLUDE_TYPES, [MEMORY_TYPE]];

  const sql = `
    SELECT
      LOWER(TRIM(m.content)) AS hash_key,
      MIN(m.id) AS canonical_id,
      array_agg(m.id ORDER BY m.id) AS all_ids,
      COUNT(*)::int AS cnt,
      m.memory_type,
      (SELECT content FROM memories WHERE id = MIN(m.id)) AS first_content
    FROM memories m
    WHERE ${conditions.join(' AND ')}
    GROUP BY LOWER(TRIM(m.content)), m.memory_type
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT ${MAX_GROUPS}
  `;

  const result = await pool.query(sql, params);
  const groups = result.rows.map(r => ({
    canonicalId: r.canonical_id,
    duplicateIds: r.all_ids.filter(id => id !== r.canonical_id),
    normalizedHash: r.hash_key,
    memoryType: r.memory_type,
    content: r.first_content,
    duplicateCount: r.cnt,
  }));

  const totalDuplicates = groups.reduce((s, g) => s + g.duplicateIds.length, 0);
  // After skip: recompute
  const SKIP_CANONICAL_IDS = new Set([43872]);
  const skippedGroups = groups.filter(g => SKIP_CANONICAL_IDS.has(g.canonicalId));
  const applyGroups = groups.filter(g => !SKIP_CANONICAL_IDS.has(g.canonicalId));
  const totalDuplicatesToApply = applyGroups.reduce((s, g) => s + g.duplicateIds.length, 0);

  console.log(`Duplicate groups found:    ${groups.length}`);
  console.log(`  To apply:                ${applyGroups.length} (${totalDuplicatesToApply} duplicates)`);
  console.log(`  Skipped:                 ${skippedGroups.length} (${skippedGroups.reduce((s, g) => s + g.duplicateIds.length, 0)} duplicates) + [continuity probe]`);
  console.log(`Canonical kept:            ${applyGroups.length}`);
  console.log(`Active after:              ${activeBefore - totalDuplicatesToApply}`);
  console.log();

  // Show all skipped
  if (skippedGroups.length > 0) {
    console.log('--- Skipped (not merged) ---');
    for (const g of skippedGroups) {
      const preview = g.content.length > 100 ? g.content.slice(0, 100) + '...' : g.content;
      console.log(`  "${preview}" — count=${g.duplicateCount} canonical=#${g.canonicalId}`);
    }
    console.log();
  }

  // Show top applied
  console.log('--- Top applied groups ---');
  for (let i = 0; i < Math.min(applyGroups.length, 20); i++) {
    const g = applyGroups[i];
    const preview = g.content.length > 100 ? g.content.slice(0, 100) + '...' : g.content;
    console.log(`  #${i + 1}: "${preview}" — count=${g.duplicateCount} canonical=#${g.canonicalId}`);
  }
  if (applyGroups.length > 20) {
    console.log(`  ... and ${applyGroups.length - 20} more groups`);
  }
  console.log();

  if (!APPLY) {
    console.log('DRY RUN — no writes performed.');
    console.log(`Active before: ${activeBefore}`);
    console.log(`Active after (simulated): ${activeBefore - totalDuplicatesToApply}`);
    console.log();
    console.log('Re-run with --apply to execute.');
    return;
  }

  // APPLY
  console.log('Applying merges...');
  let supersededCount = 0;
  let mergeRecordCount = 0;

  for (const group of applyGroups) {
    const duplicateIds = group.duplicateIds;
    if (duplicateIds.length === 0) continue;

    const updateResult = await pool.query(
      `UPDATE memories
       SET superseded_by = $1, superseded_at = now()
       WHERE id = ANY($2)
         AND superseded_by IS NULL
         AND id != $1`,
      [group.canonicalId, duplicateIds],
    );
    supersededCount += updateResult.rowCount ?? 0;

    await pool.query(
      `INSERT INTO memory_merges
       (canonical_id, duplicate_ids, reason, normalized_hash, duplicate_count, merged_by)
       VALUES ($1, $2, 'exact_content', $3, $4, 'merge-tool')`,
      [
        group.canonicalId,
        JSON.stringify(duplicateIds),
        group.normalizedHash,
        group.duplicateCount,
      ],
    );
    mergeRecordCount++;
  }

  const activeAfterApply = (await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NULL AND memory_type = ANY($1)',
    [[MEMORY_TYPE]],
  )).rows[0].cnt;

  const mergeRecordsTotal = (await pool.query(
    'SELECT COUNT(*)::int AS cnt FROM memory_merges',
  )).rows[0].cnt;

  console.log('=== Merge applied ===');
  console.log(`Groups processed:          ${mergeRecordCount}`);
  console.log(`Memories marked superseded: ${supersededCount}`);
  console.log(`Active before:             ${activeBefore}`);
  console.log(`Active after:              ${activeAfterApply}`);
  console.log(`Net reduction:             ${activeBefore - activeAfterApply}`);
  console.log(`Total merge records:       ${mergeRecordsTotal}`);
  console.log();
  console.log('No memories were deleted.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
// One-off: Dry-run merge on procedural and conversation memory types
// Run: node scripts/merge-dryrun.mjs
// Purpose: Generate merge evidence reports without applying changes
import pg from 'pg';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

const MEMORY_TYPE = process.argv.includes('--type')
  ? process.argv.find((a, i) => process.argv[i - 1] === '--type')
  : null;
const MAX_GROUPS = 200;
const EXCLUDE_TYPES = ['lesson'];

async function countActive(whereExtra, params) {
  const sql = `SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NULL ${whereExtra}`;
  const result = await pool.query(sql, params.length > 0 ? params : undefined);
  return result.rows[0].cnt;
}

async function findDuplicateGroups(memoryType) {
  const conditions = ['m.superseded_by IS NULL'];
  const params = [];
  let paramIdx = 0;

  paramIdx++;
  conditions.push(`m.memory_type != ALL($${paramIdx})`);
  params.push(EXCLUDE_TYPES);

  if (memoryType) {
    paramIdx++;
    conditions.push(`m.memory_type = ANY($${paramIdx})`);
    params.push([memoryType]);
  }

  const whereClause = conditions.join(' AND ');

  const sql = `
    SELECT
      LOWER(TRIM(m.content)) AS hash_key,
      MIN(m.id) AS canonical_id,
      array_agg(m.id ORDER BY m.id) AS all_ids,
      COUNT(*)::int AS cnt,
      m.memory_type,
      (SELECT content FROM memories WHERE id = MIN(m.id)) AS first_content,
      (SELECT created_at FROM memories WHERE id = MIN(m.id)) AS first_created_at
    FROM memories m
    WHERE ${whereClause}
    GROUP BY LOWER(TRIM(m.content)), m.memory_type
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT ${MAX_GROUPS}
  `;

  const result = await pool.query(sql, params);
  return result.rows.map(r => ({
    canonicalId: r.canonical_id,
    duplicateIds: r.all_ids.filter(id => id !== r.canonical_id),
    normalizedHash: r.hash_key,
    memoryType: r.memory_type,
    content: r.first_content,
    canonicalCreatedAt: r.first_created_at,
    duplicateCount: r.cnt,
  }));
}

async function dryRun(label, memoryType) {
  console.log(`\n${'='.repeat(72)}`);
  console.log(`DRY RUN: ${label}`);
  console.log(`Mode:       DRY RUN (no writes)`);
  console.log(`MemoryType: ${memoryType || '(all non-excluded)'}`);
  console.log(`Exclude:    [${EXCLUDE_TYPES.join(', ')}]`);
  console.log(`MaxGroups:  ${MAX_GROUPS}`);
  console.log(`${'='.repeat(72)}\n`);

  const activeBefore = await countActive(
    memoryType ? 'AND memory_type = ANY($1)' : '',
    memoryType ? [[memoryType]] : [],
  );
  console.log(`Active memories (before): ${activeBefore}`);

  const groups = await findDuplicateGroups(memoryType);
  const totalDuplicates = groups.reduce((s, g) => s + g.duplicateIds.length, 0);

  console.log(`Duplicate groups found:   ${groups.length}`);
  console.log(`Canonical memories kept:  ${groups.length}`);
  console.log(`Duplicates to supersede:  ${totalDuplicates}`);
  console.log(`Active memories (after):  ${activeBefore - totalDuplicates}`);
  console.log(`Reason:                   exact_content`);
  console.log();

  if (groups.length === 0) {
    console.log('No duplicate groups found.\n');
    return;
  }

  console.log('--- Top duplicate groups (by count) ---\n');
  for (let i = 0; i < Math.min(groups.length, 50); i++) {
    const g = groups[i];
    const contentPreview = g.content.length > 120
      ? g.content.slice(0, 120) + '...'
      : g.content;
    console.log(`Group ${i + 1}: type=${g.memoryType} count=${g.duplicateCount} canonical=#${g.canonicalId}`);
    console.log(`  Duplicates: [${g.duplicateIds.join(', ')}]`);
    console.log(`  Content: "${contentPreview}"`);
    console.log(`  Created: ${g.canonicalCreatedAt}`);
    console.log();
  }

  if (groups.length > 50) {
    console.log(`... and ${groups.length - 50} more groups\n`);
  }

  console.log('--- Summary by type ---\n');
  const byType = new Map();
  for (const g of groups) {
    const t = byType.get(g.memoryType) || { groups: 0, duplicates: 0 };
    t.groups++;
    t.duplicates += g.duplicateIds.length;
    byType.set(g.memoryType, t);
  }
  for (const [type, stats] of byType) {
    console.log(`  ${type}: ${stats.groups} groups, ${stats.duplicates} duplicates to supersede`);
  }
  console.log();

  console.log('--- Confirm (no data written) ---');
  console.log('  - No memories deleted');
  console.log('  - No memories modified');
  console.log('  - Superseded_by IS NULL count unchanged');
  console.log();
}

async function main() {
  console.log('=== Merge Dry-Run Report ===');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);

  const totalMemories = (await pool.query('SELECT COUNT(*)::int AS cnt FROM memories')).rows[0].cnt;
  const superseded = (await pool.query('SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NOT NULL')).rows[0].cnt;
  const withEmbeddings = (await pool.query('SELECT COUNT(*)::int AS cnt FROM memories WHERE embedding IS NOT NULL')).rows[0].cnt;

  console.log(`Total memories: ${totalMemories}`);
  console.log(`Already superseded: ${superseded}`);
  console.log(`With embeddings: ${withEmbeddings}`);

  const typeBreakdown = (await pool.query(
    `SELECT memory_type, COUNT(*)::int AS cnt FROM memories GROUP BY memory_type ORDER BY cnt DESC`
  )).rows;
  console.log('\nMemory type breakdown:');
  for (const row of typeBreakdown) {
    console.log(`  ${row.memory_type}: ${row.cnt}`);
  }
  console.log();

  await dryRun('Procedural only', 'procedural');
  await dryRun('Conversation only', 'conversation');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
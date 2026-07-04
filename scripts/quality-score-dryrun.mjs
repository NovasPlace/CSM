// Phase 2D: Dry-run memory quality scoring
// Run after `npm run build`: node scripts/quality-score-dryrun.mjs
import pg from 'pg';
import {
  recencyScore,
  scoreMemory,
  summarizeScores,
} from '../dist/quality-scoring.js';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function parseNumberArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number.parseInt(arg.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringArg(prefix) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function buildFilters(projectId) {
  const params = [];
  let whereClause = 'WHERE m.superseded_by IS NULL';

  if (projectId) {
    params.push(projectId);
    whereClause += ` AND m.project_id = $${params.length}`;
  }

  return { params, whereClause };
}

async function fetchExistingCount(projectId) {
  const { params, whereClause } = buildFilters(projectId);
  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM memories m ${whereClause}`,
    params.length > 0 ? params : undefined,
  );
  return result.rows[0].cnt;
}

function parseArgs() {
  return {
    batchSize: parseNumberArg('--batch-size=', 5000),
    maxTotal: parseNumberArg('--max-total=', 0),
    projectId: parseStringArg('--project-id='),
  };
}

function printSummary(target, summary) {
  console.log('=== Phase 2D: Quality Score Dry-Run ===\n');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log('Mode: DRY RUN (no writes)\n');
  console.log(`Active memories targeted: ${target}`);
  console.log(`Scored: ${summary.totalScores}`);
  console.log(`Average score: ${summary.avgScore.toFixed(3)}`);
  console.log(`Min score: ${summary.minScore.toFixed(3)}`);
  console.log(`Max score: ${summary.maxScore.toFixed(3)}`);
  console.log('\nBand counts:');
  for (const [band, count] of Object.entries(summary.bandCounts)) {
    const pct = summary.totalScores > 0 ? ((count / summary.totalScores) * 100).toFixed(1) : '0.0';
    console.log(`  ${band}: ${count} (${pct}%)`);
  }
}

async function collectScores(projectId, batchSize, maxTotal) {
  const totalActive = await fetchExistingCount(projectId);
  const target = maxTotal > 0 ? Math.min(maxTotal, totalActive) : totalActive;
  const results = [];
  let offset = 0;

  while (results.length < target) {
    const limit = Math.min(batchSize, target - results.length);
    const { params, whereClause } = buildFilters(projectId);
    const queryParams = [...params, limit, offset];
    const batch = await pool.query(
      `SELECT
         m.id,
         m.content,
         m.memory_type,
         COALESCE(m.metadata->>'title', '') AS title,
         m.importance,
         m.confidence,
         m.created_at,
         m.session_id,
         m.project_id,
         m.access_count,
         m.embedding IS NOT NULL AS has_embedding
       FROM memories m
       ${whereClause}
       ORDER BY m.id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      queryParams,
    );

    if (batch.rows.length === 0) break;

    for (const row of batch.rows) {
      const result = scoreMemory({
        contentLength: (row.content || '').length,
        hasTitle: Boolean(row.title),
        hasSourceSession: Boolean(row.session_id),
        hasProjectId: Boolean(row.project_id),
        hasMemoryType: Boolean(row.memory_type),
        hasEmbedding: Boolean(row.has_embedding),
        importance: row.importance ?? 0,
        confidence: row.confidence ?? 0,
        recency: recencyScore(row.created_at),
        duplicateStatus: 'active',
        retrievalCount: row.access_count ?? 0,
      });
      results.push(result);
    }

    offset += batch.rows.length;
  }

  return { target, summary: summarizeScores(results) };
}

async function main() {
  const { batchSize, maxTotal, projectId } = parseArgs();
  const { target, summary } = await collectScores(projectId, batchSize, maxTotal);
  printSummary(target, summary);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

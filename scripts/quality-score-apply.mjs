// Phase 2D: Apply memory quality scoring
// Default is dry-run; pass --apply to write into memory_quality_scores
import pg from 'pg';
import {
  QUALITY_SCORING_VERSION,
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

async function countScoreRows(client) {
  const result = await client.query('SELECT COUNT(*)::int AS cnt FROM memory_quality_scores');
  return result.rows[0].cnt;
}

async function fetchActiveRows(projectId) {
  const { params, whereClause } = buildFilters(projectId);
  const result = await pool.query(
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
     ORDER BY m.id`,
    params.length > 0 ? params : undefined,
  );
  return result.rows;
}

async function upsertBatch(client, rows) {
  for (const row of rows) {
    await client.query(
      `INSERT INTO memory_quality_scores
         (memory_id, memory_type, score, band, features, scoring_version, scored_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (memory_id) DO UPDATE SET
         memory_type = EXCLUDED.memory_type,
         score = EXCLUDED.score,
         band = EXCLUDED.band,
         features = EXCLUDED.features,
         scoring_version = EXCLUDED.scoring_version,
         scored_at = EXCLUDED.scored_at`,
      [
        row.memoryId,
        row.memoryType,
        row.score,
        row.band,
        JSON.stringify(row.features),
        row.scoringVersion,
        row.scoredAt,
      ],
    );
  }
}

function parseArgs() {
  return {
    shouldApply: process.argv.includes('--apply'),
    batchSize: parseNumberArg('--batch-size=', 5000),
    maxTotal: parseNumberArg('--max-total=', 0),
    projectId: parseStringArg('--project-id='),
  };
}

function scoreRows(rows, maxTotal) {
  const target = maxTotal > 0 ? rows.slice(0, maxTotal) : rows;
  const scoredRows = target.map((row) => {
    const scoredAt = new Date();
    const result = scoreMemory({
      contentLength: (row.content || '').length,
      hasTitle: Boolean(row.title),
      hasSourceSession: Boolean(row.session_id),
      hasProjectId: Boolean(row.project_id),
      hasMemoryType: Boolean(row.memory_type),
      hasEmbedding: Boolean(row.has_embedding),
      importance: row.importance ?? 0,
      confidence: row.confidence ?? 0,
      recency: recencyScore(row.created_at, scoredAt),
      duplicateStatus: 'active',
      retrievalCount: row.access_count ?? 0,
    });
    return {
      memoryId: row.id,
      memoryType: row.memory_type,
      score: result.score,
      band: result.band,
      features: result.features,
      scoringVersion: result.scoringVersion || QUALITY_SCORING_VERSION,
      scoredAt,
    };
  });

  return { targetCount: target.length, scoredRows, summary: summarizeScores(scoredRows) };
}

async function applyScores(client, shouldApply, batchSize, scoredRows) {
  const beforeCount = await countScoreRows(client);
  if (!shouldApply) {
    return { beforeCount, afterCount: beforeCount };
  }

  await client.query('BEGIN');
  try {
    for (let start = 0; start < scoredRows.length; start += batchSize) {
      await upsertBatch(client, scoredRows.slice(start, start + batchSize));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  return { beforeCount, afterCount: await countScoreRows(client) };
}

function printReport(shouldApply, targetCount, counts, summary) {
  console.log('=== Phase 2D: Quality Score Apply ===\n');
  console.log(`Date: ${new Date().toISOString()}`);
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Mode: ${shouldApply ? 'APPLY' : 'DRY RUN (no writes)'}\n`);
  console.log(`Active memories targeted: ${targetCount}`);
  console.log(`Score-table rows before: ${counts.beforeCount}`);
  console.log(`Score-table rows after: ${counts.afterCount}`);
  console.log(`Average score: ${summary.avgScore.toFixed(3)}`);
  console.log(`Min score: ${summary.minScore.toFixed(3)}`);
  console.log(`Max score: ${summary.maxScore.toFixed(3)}`);
  console.log('\nBand counts:');
  for (const [band, count] of Object.entries(summary.bandCounts)) {
    const pct = summary.totalScores > 0 ? ((count / summary.totalScores) * 100).toFixed(1) : '0.0';
    console.log(`  ${band}: ${count} (${pct}%)`);
  }
}

async function main() {
  const { shouldApply, batchSize, maxTotal, projectId } = parseArgs();
  const activeRows = await fetchActiveRows(projectId);
  const { targetCount, scoredRows, summary } = scoreRows(activeRows, maxTotal);
  const client = await pool.connect();

  try {
    const counts = await applyScores(client, shouldApply, batchSize, scoredRows);
    printReport(shouldApply, targetCount, counts, summary);
  } finally {
    client.release();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

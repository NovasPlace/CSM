// Phase 2D: Dry-run memory quality scoring
// Run: node scripts/quality-score-dryrun.mjs
// Purpose: Show score distribution without writing to DB
import pg from 'pg';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

const BATCH_SIZE = 5000;

function scoreMemory(signals) {
  const {
    contentLength,
    hasSourceSession,
    hasProjectId,
    hasMemoryType,
    hasEmbedding,
    importance,
    confidence,
    recency,
    duplicateStatus,
    accessCount,
  } = signals;

  if (duplicateStatus === 'superseded') {
    return { score: 0, reason: 'Superseded memory (not scored)' };
  }

  let score = 0;
  const reasons = [];

  // Source session: +0.1
  if (hasSourceSession) {
    score += 0.1;
    reasons.push('has source session');
  }

  // Project ID: +0.1
  if (hasProjectId) {
    score += 0.1;
    reasons.push('has project context');
  }

  // Memory type: +0.05
  if (hasMemoryType) {
    score += 0.05;
    reasons.push('has memory type');
  }

  // Embedding: +0.15
  if (hasEmbedding) {
    score += 0.15;
    reasons.push('has embedding');
  }

  // Importance: ×0.2
  score += importance * 0.2;
  if (importance > 0.7) {
    reasons.push(`high importance (${importance.toFixed(2)})`);
  } else if (importance > 0.4) {
    reasons.push(`medium importance (${importance.toFixed(2)})`);
  }

  // Confidence: ×0.15
  score += confidence * 0.15;
  if (confidence > 0.7) {
    reasons.push(`high confidence (${confidence.toFixed(2)})`);
  }

  // Recency: ×0.1
  score += recency * 0.1;

  // Access count: capped +0.15 (1 access = 0.015, 10+ = 0.15)
  const accessBonus = Math.min(accessCount * 0.015, 0.15);
  score += accessBonus;
  if (accessCount > 0) {
    reasons.push(`accessed ${accessCount}x`);
  }

  // Content length signals
  if (contentLength < 20) {
    score -= 0.1;
    reasons.push('very short content');
  } else if (contentLength >= 200 && contentLength <= 500) {
    score += 0.05;
    reasons.push('optimal length');
  } else if (contentLength > 500) {
    score += 0.02;
    reasons.push('long content');
  }

  // Clamp
  score = Math.max(0, Math.min(1, score));

  return {
    score,
    reason: reasons.length > 0 ? reasons.join(', ') : 'minimal signals',
  };
}

function getScoreBand(score) {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  if (score >= 0.2) return 'low';
  return 'very low';
}

function recencyScore(createdAt, now) {
  const ageDays = (now - new Date(createdAt)) / (1000 * 60 * 60 * 24);
  if (ageDays < 1) return 1;
  if (ageDays < 7) return 0.8;
  if (ageDays < 14) return 0.6;
  if (ageDays < 30) return 0.4;
  if (ageDays < 60) return 0.2;
  return 0.05;
}

async function main() {
  const now = new Date();

  console.log('=== Phase 2D: Quality Score Dry-Run ===\n');
  console.log(`Date: ${now.toISOString()}`);
  console.log(`DB: ${DATABASE_URL.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Mode: DRY RUN (no writes)\n`);

  // Count active memories
  const totalActive = (
    await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM memories WHERE superseded_by IS NULL'
    )
  ).rows[0].cnt;
  console.log(`Total active memories: ${totalActive}\n`);

  // Score all active memories in batches
  let offset = 0;
  const scoredMemories = [];
  const bandCounts = { high: 0, medium: 0, low: 0, 'very low': 0 };
  const scoresByType = {};

  console.log('Scoring in batches...');
  while (offset < totalActive) {
    const result = await pool.query(
      `SELECT
         m.id,
         m.content,
         m.memory_type,
         m.importance,
         m.confidence,
         m.created_at,
         m.session_id,
         m.project_id,
         m.access_count,
         m.embedding IS NOT NULL AS has_embedding
       FROM memories m
       WHERE m.superseded_by IS NULL
       ORDER BY m.id
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset]
    );

    for (const r of result.rows) {
      const rec = recencyScore(r.created_at, now);
      const { score, reason } = scoreMemory({
        contentLength: (r.content || '').length,
        hasSourceSession: !!r.session_id,
        hasProjectId: !!r.project_id,
        hasMemoryType: !!r.memory_type,
        hasEmbedding: r.has_embedding,
        importance: r.importance || 0,
        confidence: r.confidence || 0,
        recency: rec,
        duplicateStatus: 'active',
        accessCount: r.access_count || 0,
      });

      const band = getScoreBand(score);
      bandCounts[band]++;
      if (!scoresByType[r.memory_type]) {
        scoresByType[r.memory_type] = { total: 0, sum: 0, bandCounts: { high: 0, medium: 0, low: 0, 'very low': 0 } };
      }
      scoresByType[r.memory_type].total++;
      scoresByType[r.memory_type].sum += score;
      scoresByType[r.memory_type].bandCounts[band]++;

      scoredMemories.push({
        id: r.id,
        memoryType: r.memory_type,
        content: r.content,
        qualityScore: score,
        qualityReason: reason,
        scoreBand: band,
      });
    }

    offset += BATCH_SIZE;
    process.stdout.write(`  scored ${Math.min(offset, totalActive)} / ${totalActive}\r`);
  }

  console.log(`\n`);

  // Overall stats
  const sum = scoredMemories.reduce((s, m) => s + m.qualityScore, 0);
  const avgScore = sum / scoredMemories.length;
  const allScores = scoredMemories.map((m) => m.qualityScore);
  const minScore = Math.min(...allScores);
  const maxScore = Math.max(...allScores);

  console.log('=== Score Distribution ===\n');
  console.log(`Total memories scored: ${scoredMemories.length}`);
  console.log(`Average score: ${avgScore.toFixed(3)}`);
  console.log(`Min score: ${minScore.toFixed(3)}, Max score: ${maxScore.toFixed(3)}`);
  console.log();
  console.log('Band counts:');
  for (const [band, count] of Object.entries(bandCounts)) {
    const pct = ((count / scoredMemories.length) * 100).toFixed(1);
    console.log(`  ${band}: ${count} (${pct}%)`);
  }
  console.log();

  console.log('=== Score by Memory Type ===\n');
  for (const [type, data] of Object.entries(scoresByType).sort(
    (a, b) => b[1].total - a[1].total
  )) {
    const avg = data.total > 0 ? data.sum / data.total : 0;
    console.log(
      `  ${type}: ${data.total} memories, avg ${avg.toFixed(3)}, bands: high=${data.bandCounts.high} medium=${data.bandCounts.medium} low=${data.bandCounts.low} very_low=${data.bandCounts['very low']}`
    );
  }
  console.log();

  // Top 20
  const top = [...scoredMemories]
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, 20);
  console.log('=== Top 20 Highest-Scoring Memories ===\n');
  for (let i = 0; i < top.length; i++) {
    const m = top[i];
    const preview = (m.content || '').slice(0, 80);
    console.log(
      `  #${i + 1}: [${m.scoreBand}] type=${m.memoryType} score=${m.qualityScore.toFixed(3)} id=${m.id}`
    );
    console.log(`    "${preview}${m.content.length > 80 ? '...' : ''}"`);
    console.log(`    reason: ${m.qualityReason}`);
    console.log();
  }

  // Bottom 20
  const bottom = [...scoredMemories]
    .sort((a, b) => a.qualityScore - b.qualityScore)
    .slice(0, 20);
  console.log('=== Bottom 20 Lowest-Scoring Memories ===\n');
  for (let i = 0; i < bottom.length; i++) {
    const m = bottom[i];
    const preview = (m.content || '').slice(0, 80);
    console.log(
      `  #${i + 1}: [${m.scoreBand}] type=${m.memoryType} score=${m.qualityScore.toFixed(3)} id=${m.id}`
    );
    console.log(`    "${preview}${m.content.length > 80 ? '...' : ''}"`);
    console.log(`    reason: ${m.qualityReason}`);
    console.log();
  }

  console.log('DRY RUN complete. No scores written to DB.');
  console.log('Run quality-score-apply.mjs --apply to write scores.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

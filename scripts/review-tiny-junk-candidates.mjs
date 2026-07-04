// Phase 2C.5.1: Tiny-Junk Apply Review (read-only)
// Reviews all 163 dry-run candidates with full metadata and classifies each.
import pg from 'pg';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function classify(row) {
  const content = row.content;
  const type = row.memory_type;

  // False positive check: filter should prevent these, but verify
  if (row.recall_count > 0) return { classification: 'false_positive', reason: `recall_count=${row.recall_count}` };
  if (row.access_count > 1) return { classification: 'false_positive', reason: `access_count=${row.access_count} (>1)` };

  if (type === 'episodic') {
    // [modified] file events are pure auto-captured noise
    if (/^\[modified\] /.test(content)) return { classification: 'safe_archive', reason: 'file-change event (auto-captured)' };
    // [created] / [deleted] / [renamed] similarly
    if (/^\[(created|deleted|renamed|moved|added)\] /.test(content)) return { classification: 'safe_archive', reason: 'file-change event (auto-captured)' };
    // Very short episodic with no semantic content
    if (content.length < 25 && !/[A-Z]{3,}|http|error|fail/i.test(content)) return { classification: 'safe_archive', reason: 'very short episodic, no semantic signal' };
    return { classification: 'uncertain', reason: 'episodic content needs review' };
  }

  if (type === 'conversation') {
    // Trivial acknowledgments / noise
    const trivial = /^\[(user|assistant)\]\s+(aye|ayooo|hey|hi|ok|kk|k\b|yes|no|yep|nope|done|ready|hey\.|cool|nice|hmm|lol|wat|brb|gtg|fjfj|adda|test|word|right|sure|again|retry|continue|stop|go|aye\b)\s*$/i;
    if (trivial.test(content)) return { classification: 'safe_archive', reason: 'trivial acknowledgment / noise' };
    // Single-word or very short with no info
    if (content.length < 20 && /^\[(user|assistant)\]\s+\S{0,15}\s*$/.test(content)) return { classification: 'safe_archive', reason: 'single-token message' };
    // Questions or statements — might have context value
    if (/\?/.test(content)) return { classification: 'uncertain', reason: 'question — may have context value' };
    // Anything else short
    if (content.length < 50) return { classification: 'uncertain', reason: 'short conversation — review for context' };
    return { classification: 'keep_active', reason: 'conversation content above noise threshold' };
  }

  // workspace, repo, procedural — rare in this set, review individually
  return { classification: 'uncertain', reason: `${type} — review individually` };
}

async function main() {
  // Load all candidates with full metadata
  const result = await pool.query(`
    SELECT
      m.id,
      m.memory_type,
      m.content,
      m.access_count,
      m.created_at,
      m.superseded_by,
      mq.score::float AS quality_score,
      mq.band AS quality_band,
      COALESCE(r.recall_count, 0)::int AS recall_count,
      EXTRACT(EPOCH FROM (now() - m.created_at)) / 86400 AS age_days
    FROM memories m
    LEFT JOIN memory_quality_scores mq ON mq.memory_id = m.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS recall_count FROM memory_recall_events WHERE memory_id = m.id
    ) r ON true
    WHERE m.superseded_by IS NULL
      AND m.archived_at IS NULL
      AND m.memory_type IN ('episodic','conversation','workspace','repo','procedural')
      AND length(m.content) < 120
      AND EXTRACT(EPOCH FROM (now() - m.created_at)) / 86400 >= 14
      AND COALESCE(m.access_count, 0) <= 1
      AND COALESCE(r.recall_count, 0) = 0
      AND COALESCE(mq.score, 0.3) <= 0.4
    ORDER BY m.memory_type, m.id
  `);

  const rows = result.rows;
  console.log(`=== Phase 2C.5.1: Tiny-Junk Apply Review ===\n`);
  console.log(`Total candidates: ${rows.length}\n`);

  // Classify all
  const classified = rows.map((r) => ({
    ...r,
    ...classify(r),
  }));

  // === ALL conversation candidates ===
  const conv = classified.filter((r) => r.memory_type === 'conversation');
  console.log(`=== ALL ${conv.length} CONVERSATION CANDIDATES ===\n`);
  for (const r of conv) {
    console.log(`  id=${r.id} [${r.classification}] score=${(r.quality_score ?? 0).toFixed(2)} band=${r.quality_band ?? '?'} access=${r.access_count} recall=${r.recall_count} age=${Math.round(r.age_days)}d`);
    console.log(`    content: "${r.content}"`);
    console.log(`    reason: ${r.reason}`);
    console.log();
  }

  // === Sample 30 episodic candidates (spread across the ID range) ===
  const epi = classified.filter((r) => r.memory_type === 'episodic');
  const step = Math.max(1, Math.floor(epi.length / 30));
  const epiSample = [];
  for (let i = 0; i < epi.length; i += step) epiSample.push(epi[i]);
  console.log(`=== SAMPLED ${epiSample.length} OF ${epi.length} EPISODIC CANDIDATES ===\n`);
  for (const r of epiSample) {
    console.log(`  id=${r.id} [${r.classification}] score=${(r.quality_score ?? 0).toFixed(2)} band=${r.quality_band ?? '?'} access=${r.access_count} recall=${r.recall_count} age=${Math.round(r.age_days)}d`);
    console.log(`    content: "${r.content}"`);
    console.log();
  }

  // === Classification summary ===
  const byClass = {};
  const byTypeClass = {};
  for (const r of classified) {
    byClass[r.classification] = (byClass[r.classification] || 0) + 1;
    const key = `${r.memory_type}:${r.classification}`;
    byTypeClass[key] = (byTypeClass[key] || 0) + 1;
  }
  console.log(`=== CLASSIFICATION SUMMARY ===\n`);
  console.log('By classification:');
  for (const [c, n] of Object.entries(byClass).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${c}: ${n}`);
  }
  console.log();
  console.log('By type:classification:');
  for (const [k, n] of Object.entries(byTypeClass).sort()) {
    console.log(`  ${k}: ${n}`);
  }
  console.log();

  // === Stats by type ===
  console.log(`=== STATS BY TYPE ===\n`);
  for (const type of ['conversation', 'episodic']) {
    const subset = classified.filter((r) => r.memory_type === type);
    const scores = subset.map((r) => r.quality_score ?? 0);
    const minS = Math.min(...scores);
    const maxS = Math.max(...scores);
    const avgS = scores.reduce((a, b) => a + b, 0) / scores.length;
    const bands = {};
    for (const r of subset) bands[r.quality_band ?? '(null)'] = (bands[r.quality_band ?? '(null)'] || 0) + 1;
    const accessDist = {};
    for (const r of subset) accessDist[r.access_count] = (accessDist[r.access_count] || 0) + 1;
    console.log(`${type} (${subset.length} candidates):`);
    console.log(`  score: min=${minS.toFixed(3)} max=${maxS.toFixed(3)} avg=${avgS.toFixed(3)}`);
    console.log(`  bands: ${JSON.stringify(bands)}`);
    console.log(`  access_count: ${JSON.stringify(accessDist)}`);
    console.log(`  recall_count: all 0`);
    console.log();
  }

  // === Recommendation ===
  const safeConv = conv.filter((r) => r.classification === 'safe_archive').length;
  const uncertainConv = conv.filter((r) => r.classification === 'uncertain').length;
  const safeEpi = epi.filter((r) => r.classification === 'safe_archive').length;
  const uncertainEpi = epi.filter((r) => r.classification === 'uncertain').length;

  console.log(`=== RECOMMENDATION ===\n`);
  console.log(`Conversation: ${safeConv} safe, ${uncertainConv} uncertain, ${conv.length} total`);
  console.log(`Episodic:     ${safeEpi} safe, ${uncertainEpi} uncertain, ${epi.length} total`);
  console.log();
  if (uncertainConv > 0) {
    console.log(`RECOMMENDATION: Apply episodic-only first (${safeEpi} safe).`);
    console.log(`Hold conversation (${uncertainConv} uncertain need human review).`);
  } else {
    console.log(`RECOMMENDATION: All conversation safe. Apply all ${safeConv + safeEpi}.`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => pool.end());

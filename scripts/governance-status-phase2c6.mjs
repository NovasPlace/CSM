import fs from 'node:fs';
import pg from 'pg';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function query(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function collectStatus() {
  const totals = await query(`
    SELECT
      COUNT(*)::int AS total_memories,
      COUNT(*) FILTER (WHERE archived_at IS NULL AND superseded_by IS NULL)::int AS active_memories,
      COUNT(*) FILTER (WHERE superseded_by IS NOT NULL)::int AS superseded_count,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL)::int AS archived_count,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL AND archive_reason = 'already_superseded_duplicate')::int AS archived_superseded,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL AND archive_reason = 'tiny_type_specific_junk')::int AS archived_tiny_junk
    FROM memories
  `);

  const byReason = await query(`
    SELECT archive_reason, COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NOT NULL
    GROUP BY archive_reason
    ORDER BY cnt DESC
  `);

  const byType = await query(`
    SELECT memory_type, COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NULL AND superseded_by IS NULL
    GROUP BY memory_type
    ORDER BY cnt DESC
  `);

  const batches = await query(`
    SELECT archive_batch_id, archive_reason, COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NOT NULL
    GROUP BY archive_batch_id, archive_reason
    ORDER BY cnt DESC
  `);

  const unarchivedTinyConversation = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories m
    LEFT JOIN memory_quality_scores mq ON mq.memory_id = m.id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS recall_count FROM memory_recall_events WHERE memory_id = m.id
    ) r ON true
    WHERE m.superseded_by IS NULL
      AND m.archived_at IS NULL
      AND m.memory_type = 'conversation'
      AND length(m.content) < 120
      AND EXTRACT(EPOCH FROM (now() - m.created_at)) / 86400 >= 14
      AND COALESCE(m.access_count, 0) <= 1
      AND COALESCE(r.recall_count, 0) = 0
      AND COALESCE(mq.score, 0.3) <= 0.4
  `);

  const lowAccessExcluded = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories m
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS recall_count FROM memory_recall_events WHERE memory_id = m.id
    ) r ON true
    WHERE m.superseded_by IS NULL
      AND m.archived_at IS NULL
      AND EXTRACT(EPOCH FROM (now() - m.created_at)) / 86400 >= 14
      AND COALESCE(m.access_count, 0) <= 1
      AND COALESCE(r.recall_count, 0) = 0
  `);

  const scored = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memory_quality_scores mq
    JOIN memories m ON m.id = mq.memory_id
    WHERE m.archived_at IS NULL AND m.superseded_by IS NULL
  `);

  return {
    generatedAt: new Date().toISOString(),
    totals: totals[0],
    archivedByReason: Object.fromEntries(byReason.map((r) => [r.archive_reason, r.cnt])),
    activeByType: Object.fromEntries(byType.map((r) => [r.memory_type, r.cnt])),
    batches: batches.map((r) => ({ batchId: r.archive_batch_id, reason: r.archive_reason, count: r.cnt })),
    unarchivedTinyConversation: unarchivedTinyConversation[0].cnt,
    lowAccessExcluded: lowAccessExcluded[0].cnt,
    scoredActive: scored[0].cnt,
  };
}

async function runInvariants(status) {
  const results = [];

  const inv1 = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NOT NULL
      AND archive_reason = 'already_superseded_duplicate'
      AND superseded_by IS NULL
  `);
  results.push({
    name: 'superseded_archive_has_superseded_by',
    expect: 'archived already_superseded_duplicate rows must have superseded_by IS NOT NULL',
    actual: inv1[0].cnt,
    pass: inv1[0].cnt === 0,
  });

  const inv2 = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NOT NULL
      AND archive_reason = 'tiny_type_specific_junk'
      AND superseded_by IS NOT NULL
  `);
  results.push({
    name: 'tiny_junk_archive_is_not_superseded',
    expect: 'archived tiny_type_specific_junk rows must have superseded_by IS NULL',
    actual: inv2[0].cnt,
    pass: inv2[0].cnt === 0,
  });

  const inv3 = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NOT NULL
      AND memory_type = 'conversation'
      AND archive_reason = 'tiny_type_specific_junk'
  `);
  results.push({
    name: 'no_conversation_tiny_junk_archived',
    expect: 'archived conversation tiny-junk count must be 0',
    actual: inv3[0].cnt,
    pass: inv3[0].cnt === 0,
  });

  const totalArchived = status.totals.archived_count;
  const expectedTotal = 7241 + 138;
  results.push({
    name: 'total_archived_equals_7379',
    expect: `total archived = ${expectedTotal}`,
    actual: totalArchived,
    pass: totalArchived === expectedTotal,
  });

  const inv5 = await query(`
    SELECT COUNT(*)::int AS cnt
    FROM memories
    WHERE archived_at IS NOT NULL
      AND archive_reason = 'tiny_type_specific_junk'
      AND memory_type != 'episodic'
  `);
  results.push({
    name: 'tiny_junk_archive_is_episodic_only',
    expect: 'all archived tiny_type_specific_junk rows must be episodic',
    actual: inv5[0].cnt,
    pass: inv5[0].cnt === 0,
  });

  return results;
}

async function main() {
  const status = await collectStatus();
  const invariants = await runInvariants(status);

  const report = { ...status, invariants };

  const stamp = timestamp();
  const jsonPath = `.tmp/governance-status-phase2c6-${stamp}.json`;
  const textPath = `.tmp/governance-status-phase2c6-${stamp}.txt`;

  const textLines = [
    `=== Governance Status Report — Phase 2C.6 ===`,
    `Generated: ${status.generatedAt}`,
    '',
    `--- Totals ---`,
    `Total memories:        ${status.totals.total_memories}`,
    `Active memories:       ${status.totals.active_memories}`,
    `Superseded count:      ${status.totals.superseded_count}`,
    `Archived count:        ${status.totals.archived_count}`,
    `Scored active:         ${status.scoredActive}`,
    '',
    `--- Archived by Reason ---`,
    ...Object.entries(status.archivedByReason).map(([reason, cnt]) => `  ${reason}: ${cnt}`),
    '',
    `--- Restore Batches ---`,
    ...status.batches.map((b) => `  ${b.batchId}: ${b.count} (${b.reason})`),
    '',
    `--- Active by Type ---`,
    ...Object.entries(status.activeByType).map(([type, cnt]) => `  ${type}: ${cnt}`),
    '',
    `--- Conversation Tiny-Junk ---`,
    `  Unarchived conversation tiny-junk: ${status.unarchivedTinyConversation}`,
    `  Note: held indefinitely; no conversation rows archived`,
    '',
    `--- Excluded Categories ---`,
    `  Low-access (excluded from archive): ${status.lowAccessExcluded}`,
    '',
    `--- Invariants ---`,
    ...invariants.map((inv) => `  ${inv.pass ? 'PASS' : 'FAIL'} ${inv.name}: actual=${inv.actual} (expect: ${inv.expect})`),
    '',
  ];

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(textPath, textLines.join('\n') + '\n');

  console.log(jsonPath);
  console.log(textPath);
  console.log(textLines.join('\n'));

  const allPass = invariants.every((inv) => inv.pass);
  if (!allPass) {
    console.error('INVARIANT FAILURE');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

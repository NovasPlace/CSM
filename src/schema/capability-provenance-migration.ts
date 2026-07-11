import { dialectFromPool, jsonExtractText, nowFn } from '../db/query-dialect.js';
import { getLogger } from '../logger.js';
import type { DatabasePool } from '../types.js';

export interface ProvenanceMigrationResult {
  found: number;
  migrated: number;
  alreadyMigrated: number;
  skipped: number;
  skippedDetails: string[];
}

interface LegacyRecord {
  id: number;
  metadata: unknown;
  dedup_key: string | null;
  promoted_at: string | null;
  reinforcement_count: number | null;
  evidence_sessions: number | null;
}

function extractToolNameFromDedupKey(dedupKey: string): string | null {
  const match = dedupKey.match(/^cap:(.+):ok$/);
  return match ? match[1] : null;
}

function parseMeta(row: LegacyRecord): Record<string, unknown> {
  if (typeof row.metadata === 'string') {
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (row.metadata && typeof row.metadata === 'object') {
    return row.metadata as Record<string, unknown>;
  }
  return {};
}

export async function runCapabilityProvenanceMigration(
  pool: DatabasePool,
): Promise<ProvenanceMigrationResult> {
  const d = dialectFromPool(pool);
  const log = getLogger();
  const ct = jsonExtractText(d, 'metadata', 'candidate_type');
  const ps = jsonExtractText(d, 'metadata', 'promotion_source');
  const dk = jsonExtractText(d, 'metadata', 'dedup_key');
  const pa = jsonExtractText(d, 'metadata', 'promoted_at');
  const rc = jsonExtractText(d, 'metadata', 'reinforcement_count');
  const es = jsonExtractText(d, 'metadata', 'evidence_sessions');
  const now = nowFn(d);

  const allResult = await pool.query(
    `SELECT id, metadata, ${dk} AS dedup_key, ${pa} AS promoted_at, ${rc} AS reinforcement_count, ${es} AS evidence_sessions
     FROM memories
     WHERE ${ct} = 'candidate_capability'
       AND ${ps} = 'belief_promotion_engine'`,
  );

  const allRows = allResult.rows as LegacyRecord[];
  const found = allRows.length;

  let migrated = 0;
  let alreadyMigrated = 0;
  let skipped = 0;
  const skippedDetails: string[] = [];

  for (const row of allRows) {
    const meta = parseMeta(row);

    if (meta.record_type === 'capability_provenance') {
      alreadyMigrated++;
      continue;
    }

    const dedupKey = row.dedup_key ?? (meta.dedup_key as string | undefined) ?? null;
    if (!dedupKey) {
      skipped++;
      skippedDetails.push(`memory #${row.id}: no dedup_key in metadata`);
      continue;
    }

    const toolName = extractToolNameFromDedupKey(dedupKey);
    if (!toolName) {
      skipped++;
      skippedDetails.push(`memory #${row.id}: unparseable dedup_key '${dedupKey}' (expected cap:<tool>:ok)`);
      continue;
    }

    const canonicalKey = `tool:${toolName}:reliability`;
    const reinforcedAt = row.promoted_at ?? (meta.promoted_at as string | undefined) ?? 'unknown';
    const reinCount = Number(row.reinforcement_count ?? meta.reinforcement_count ?? 0);
    const sessCount = Number(row.evidence_sessions ?? meta.evidence_sessions ?? 0);

    const newContent = `[Capability provenance] Capability for ${canonicalKey} crossed promotion threshold at ${reinforcedAt} based on ${reinCount} reinforcements across ${sessCount} sessions. [Snapshot — self-model holds current live state.]`;

    const newMeta: Record<string, unknown> = {
      ...meta,
      record_type: 'capability_provenance',
      canonical_key: canonicalKey,
    };

    await pool.query(
      `UPDATE memories SET content = $1, metadata = $2, updated_at = ${now} WHERE id = $3`,
      [newContent, JSON.stringify(newMeta), row.id],
    );

    migrated++;
  }

  log.info(
    `Capability provenance migration 20260711-023: found=${found} migrated=${migrated} alreadyMigrated=${alreadyMigrated} skipped=${skipped}`,
  );
  if (skippedDetails.length > 0) {
    for (const detail of skippedDetails) {
      log.warn(`Capability provenance migration skipped: ${detail}`);
    }
  }

  return { found, migrated, alreadyMigrated, skipped, skippedDetails };
}

#!/usr/bin/env node
/**
 * Backfill provenance metadata on existing memories that lack it.
 * Safe to re-run (idempotent — only updates rows where source_kind IS NULL).
 *
 * Usage: node scripts/backfill-provenance.mjs [--dry-run]
 */
import pg from 'pg';

const DRY_RUN = process.argv.includes('--dry-run');
const BATCH = 2000;

const pool = new pg.Pool({
  host: 'localhost',
  port: 5432,
  database: 'opencode_memory',
  user: 'opencode_memory',
  password: 'opencode_memory',
});

// Map memory_type → source_kind
const SOURCE_KIND_MAP = {
  episodic: 'transcript',
  conversation: 'transcript',
  procedural: 'transcript',
  repo: 'repo_metadata',
  lesson: 'lesson',
  workspace: 'workspace',
  preference: 'user_supplied',
};

async function backfill() {
  const client = await pool.connect();
  try {
    // Count total
    const { rows: [{ cnt }] } = await client.query(
      `SELECT COUNT(*) as cnt FROM memories WHERE metadata->>'source_kind' IS NULL`
    );
    console.log(`Found ${cnt} memories without provenance`);

    if (cnt === 0) {
      console.log('Nothing to backfill');
      return;
    }

    let updated = 0;
    for (const [memType, sourceKind] of Object.entries(SOURCE_KIND_MAP)) {
      const sql = `
        UPDATE memories
        SET metadata = jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  metadata,
                  '{source_kind}', to_jsonb($1::text)
                ),
                '{evidence_strength}', '"direct_original"'
              ),
              '{source_surface}', '"opencode"'
            ),
            '{source_agent_id}', '"csa-legacy"'
          ),
          '{backfilled}', 'true'
        )
        WHERE memory_type = $2
          AND metadata->>'source_kind' IS NULL
      `;

      if (DRY_RUN) {
        const { rows: [{ cnt: toUpdate }] } = await client.query(
          `SELECT COUNT(*) as cnt FROM memories WHERE memory_type = $1 AND metadata->>'source_kind' IS NULL`,
          [memType]
        );
        console.log(`  [dry-run] Would update ${toUpdate} ${memType} memories with source_kind=${sourceKind}`);
        updated += Number(toUpdate);
      } else {
        const result = await client.query(sql, [sourceKind, memType]);
        console.log(`  Updated ${result.rowCount} ${memType} memories → source_kind=${sourceKind}`);
        updated += result.rowCount;
      }
    }

    console.log(`\n${DRY_RUN ? '[dry-run] Total would update' : 'Total updated'}: ${updated}`);

    // Verify
    const { rows: [{ cnt: remaining }] } = await client.query(
      `SELECT COUNT(*) as cnt FROM memories WHERE metadata->>'source_kind' IS NULL`
    );
    console.log(`Remaining without provenance: ${remaining}`);
  } finally {
    client.release();
    await pool.end();
  }
}

backfill().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});

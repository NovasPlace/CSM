const { Pool } = require('./node_modules/pg');
const { createHash } = require('node:crypto');

const pool = new Pool({
  connectionString: 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory',
});

function migrationChecksum(parts) {
  return createHash('sha256')
    .update(parts.join('\n---csm-migration-artifact---\n'), 'utf8')
    .digest('hex');
}

(async () => {
  try {
    const result = await pool.query(
      "SELECT migration_id, checksum, provider FROM csm_schema_migrations ORDER BY migration_id"
    );
    
    const knownMigrations = [
      '20260709-001-vector-extension',
      '20260709-002-session',
      '20260709-003-memory',
      '20260709-004-core',
      '20260709-005-project-isolation',
      '20260709-006-checkpoint',
      '20260709-007-context-compilation',
      '20260709-008-context-cache',
      '20260709-009-rollover',
      '20260709-010-goal',
      '20260709-011-recall-telemetry',
      '20260709-012-self-continuity',
      '20260709-013-cross-session-causal',
      '20260709-014-trace-vault',
      '20260709-015-graph',
      '20260709-016-work-journal',
      '20260709-017-candidate-queue',
      '20260709-018-experience-packet',
      '20260709-019-self-model',
      '20260709-020-belief-knowledge',
      '20260710-021-work-ledger',
      '20260710-022-coordination-persistence',
      '20260711-023-capability-provenance-rewrite',
    ];

    const knownSet = new Set(knownMigrations);
    
    console.log('=== Migrations in DB vs Source ===');
    for (const row of result.rows) {
      const inSource = knownSet.has(row.migration_id);
      console.log(`  ${row.migration_id}: ${inSource ? 'OK (in source)' : '*** UNKNOWN (not in source) ***'}  checksum=${row.checksum.slice(0, 16)}...`);
    }
    
    const unknown = result.rows.filter(r => !knownSet.has(r.migration_id));
    if (unknown.length > 0) {
      console.log('\n=== UNKNOWN MIGRATIONS (will cause plugin load failure) ===');
      for (const u of unknown) {
        console.log(`  ${u.migration_id}  applied=${u.provider}`);
      }
    } else {
      console.log('\nAll DB migrations are known to current source.');
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    pool.end();
  }
})();

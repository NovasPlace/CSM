const { createHash } = require('node:crypto');
const { Pool } = require('./node_modules/pg');

const pool = new Pool({
  connectionString: 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory',
});

function migrationChecksum(parts) {
  return createHash('sha256')
    .update(parts.join('\n---csm-migration-artifact---\n'), 'utf8')
    .digest('hex');
}

const id = '20260711-023-capability-provenance-rewrite';
const contract = 'csm-postgres-v2:rewrite capability promotion memories as immutable provenance snapshots';
const impl = ['src/schema/capability-provenance-migration.ts:sha256:f42646c5e692d7011f7517d9401903f332b4fde9c5a7492d6e1383e862732cb4'];
const acceptedLegacy = ['1369e77dffefa86e3d4b6d8612bdd3c8a743762bf519dba31ffe4b5c19d7672e'];

const currentChecksum = migrationChecksum([id, contract, ...impl]);
console.log('Current expected checksum:  ', currentChecksum);
console.log('Accepted legacy checksums: ', acceptedLegacy);

(async () => {
  try {
    const r = await pool.query(
      "SELECT migration_id, checksum, provider, applied_at FROM csm_schema_migrations WHERE migration_id = $1",
      [id]
    );
    if (r.rows.length === 0) {
      console.log('DB has NO row for this migration');
    } else {
      for (const row of r.rows) {
        console.log('DB stored checksum:      ', row.checksum);
        console.log('DB stored provider:      ', row.provider);
        console.log('DB stored applied_at:    ', row.applied_at);
        console.log('Matches current?         ', row.checksum === currentChecksum);
        console.log('Matches accepted legacy? ', acceptedLegacy.includes(row.checksum));
      }
    }

    const all = await pool.query("SELECT migration_id, checksum FROM csm_schema_migrations ORDER BY migration_id");
    console.log('\nAll applied migrations:');
    for (const row of all.rows) {
      console.log(`  ${row.migration_id}: ${row.checksum.slice(0, 16)}...`);
    }
  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    pool.end();
  }
})();

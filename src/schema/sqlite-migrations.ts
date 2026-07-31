import type { DatabasePool } from '../types.js';
import { initializeAgentBookSchema } from './agentbook-schema.js';
import { runCapabilityProvenanceMigration } from './capability-provenance-migration.js';
import { initializeContextInjectionTelemetrySchema } from './context-injection-telemetry-schema.js';
import { artifactsFor } from './migration-artifacts.js';
import type { SchemaMigration } from './migration-ledger.js';
import { migrateCompactionMetricsSqlite } from './sqlite/compaction-metrics-migration.js';
import { initializeMinimalSqliteSchema } from './sqlite/index.js';
import { initializeSqliteWorkJournal } from './sqlite/work-journal.js';
import { migrateCompactionAttribution } from './compaction-attribution-migration.js';

export const SQLITE_MIGRATION_IDS: readonly string[] = [
  '20260709-001-sqlite-baseline',
  '20260711-002-sqlite-work-journal',
  '20260711-023-capability-provenance-rewrite',
  '20260711-024-sqlite-compaction-metrics',
  '20260712-025-sqlite-context-injection-telemetry',
  '20260713-026-sqlite-agentbook',
  '20260721-027-sqlite-compaction-attribution',
];

export function buildSqliteMigrations(pool: DatabasePool): SchemaMigration[] {
  return [
    sqliteMigration(0, 'core memory, graph, recall, packets, self-model, and beliefs',
      () => initializeMinimalSqliteSchema(pool), 'v1'),
    sqliteMigration(1, 'persistent agent work journal',
      () => initializeSqliteWorkJournal(pool)),
    {
      ...sqliteMigration(2, 'rewrite capability promotion memories as immutable provenance snapshots',
        () => runCapabilityProvenanceMigration(pool).then(() => undefined)),
      acceptedLegacyChecksums: ['5f2309483f18cc3e9de81eba037489a7ce4b0727e5c58d2a0ba4ae5ef40c88f8'],
    },
    sqliteMigration(3, 'compaction telemetry metrics table with partial-schema repair',
      () => migrateCompactionMetricsSqlite(pool)),
    sqliteMigration(4, 'context injection telemetry events and items',
      () => initializeContextInjectionTelemetrySchema(pool)),
    sqliteMigration(5, 'agentbook operational ledger, summaries, current state, and rules',
      () => initializeAgentBookSchema(pool)),
    sqliteMigration(6, 'database-wide compaction attribution and failure diagnostics',
      () => migrateCompactionAttribution(pool)),
  ];
}

function sqliteMigration(
  index: number,
  contract: string,
  run: () => Promise<void>,
  version = 'v2',
): SchemaMigration {
  const id = SQLITE_MIGRATION_IDS[index];
  return { id, contract: `csm-sqlite-${version}:${contract}`, implementation: artifactsFor(id), run };
}

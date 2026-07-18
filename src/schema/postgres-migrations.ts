import { initializeBeliefKnowledgeSchema } from '../belief-knowledge-schema.js';
import { initializeCandidateSchema } from '../candidate-schema.js';
import { initializeCheckpointSchema } from '../checkpoint-schema.js';
import { initializeCoordinationPersistenceSchema } from '../coordination-persistence/schema.js';
import { initializeContextCompilationSchema } from '../context-compilation-schema.js';
import { initializeContextCacheSchema } from '../context-cache-schema.js';
import { initializeContextInjectionTelemetrySchema } from './context-injection-telemetry-schema.js';
import { initializeRolloverSchema } from '../context-rollover-schema.js';
import { initializeCrossSessionCausalSchema } from '../cross-session-causal-schema.js';
import type { Database } from '../database.js';
import { initializeExperiencePacketSchema } from '../experience-packet-schema.js';
import { initializeGoalSchema } from '../goal-schema.js';
import { initializeGraphSchema } from '../memory-graph.js';
import { initializeRecallTelemetrySchema } from '../recall-telemetry.js';
import { initializeSelfContinuitySchema } from '../self-continuity-schema.js';
import { initializeSelfModelSchema } from '../self-model-schema.js';
import { initializeTraceVaultSchema } from '../trace-vault-store.js';
import type { DatabasePool } from '../types.js';
import { initializeWorkJournalSchema } from '../work-journal-schema.js';
import { initializeCoreSchema } from './core-schema.js';
import { artifactsFor, historicalArtifactSetsFor } from './migration-artifacts.js';
import { migrationChecksum, type SchemaMigration } from './migration-ledger.js';
import { initializeMemorySchema } from './memory-schema.js';
import { migrateProjectIsolation } from './project-isolation-schema.js';
import { initializeSessionSchema } from './session-schema.js';
import { initializeWorkLedgerSchema } from '../work-ledger-schema.js';
import { runCapabilityProvenanceMigration } from './capability-provenance-migration.js';
import { initializeAgentBookSchema } from './agentbook-schema.js';
import { migrateEmbeddingDimensions } from './embedding-dimension-migration.js';

export function buildPostgresMigrations(
  database: Database, pool: DatabasePool, dimensions = 1_536,
): SchemaMigration[] {
  const graphDatabase = { dialect: database.dialect, getPool: () => pool };
  return [
    migration('20260709-001-vector-extension', 'pgvector extension', vectorExtension(pool), ['CREATE EXTENSION IF NOT EXISTS vector']),
    migration('20260709-002-session', 'sessions, events, and session contexts', () => initializeSessionSchema(pool)),
    withAcceptedLegacy(
      migration('20260709-003-memory', 'memories, chunks, merges, search, and archive metadata', () => initializeMemorySchema(pool, dimensions)),
      ['6f13c75b1355c9fbfae316d894ac6e211dfaaa7f42ace36d2c01d5dd41b924e4'],
    ),
    migration('20260709-004-core', 'distillation, compaction, candidates, projects, and quality', () => initializeCoreSchema(pool)),
    migration('20260709-005-project-isolation', 'project ids and project-scoped indexes', () => migrateProjectIsolation(pool)),
    migration('20260709-006-checkpoint', 'checkpoint persistence', () => initializeCheckpointSchema(pool)),
    migration('20260709-007-context-compilation', 'context compilation metrics and logs', () => initializeContextCompilationSchema(pool)),
    migration('20260709-008-context-cache', 'context cache persistence', () => initializeContextCacheSchema(pool)),
    migration('20260709-009-rollover', 'context rollover persistence', () => initializeRolloverSchema(pool)),
    migration('20260709-010-goal', 'goal persistence', () => initializeGoalSchema(pool)),
    migration('20260709-011-recall-telemetry', 'memory recall telemetry', () => initializeRecallTelemetrySchema(pool)),
    migration('20260709-012-self-continuity', 'self continuity records', () => initializeSelfContinuitySchema(pool)),
    migration('20260709-013-cross-session-causal', 'cross-session causal links', () => initializeCrossSessionCausalSchema(pool)),
    migration('20260709-014-trace-vault', 'trace vault persistence', () => initializeTraceVaultSchema(pool)),
    migration('20260709-015-graph', 'memory graph links and indexes', () => initializeGraphSchema(graphDatabase)),
    migration('20260709-016-work-journal', 'agent work journal', () => initializeWorkJournalSchema(pool)),
    migration('20260709-017-candidate-queue', 'unified candidate queue', () => initializeCandidateSchema(pool)),
    migration('20260709-018-experience-packet', 'experience packets', () => initializeExperiencePacketSchema(pool)),
    migration('20260709-019-self-model', 'self-model capabilities', () => initializeSelfModelSchema(pool)),
    migration('20260709-020-belief-knowledge', 'belief knowledge store', () => initializeBeliefKnowledgeSchema(pool)),
    migrationV2('20260710-021-work-ledger', 'run-level file change provenance and survival lineage', () => initializeWorkLedgerSchema(pool)),
    migrationV2('20260710-022-coordination-persistence', 'coordination state, audit events, and idempotency', () => initializeCoordinationPersistenceSchema(pool)),
    withAcceptedLegacy(
      migrationV2('20260711-023-capability-provenance-rewrite', 'rewrite capability promotion memories as immutable provenance snapshots', () => runCapabilityProvenanceMigration(pool).then(() => undefined)),
      ['1369e77dffefa86e3d4b6d8612bdd3c8a743762bf519dba31ffe4b5c19d7672e'],
    ),
    migrationV2('20260712-024-context-injection-telemetry', 'context injection telemetry events and items', () => initializeContextInjectionTelemetrySchema(pool)),
    migrationV2('20260713-025-agentbook', 'agentbook operational ledger, summaries, current state, and rules', () => initializeAgentBookSchema(pool)),
    migrationV2('20260718-026-postgres-embedding-dimension', 'explicit provider embedding dimension transition', () => migrateEmbeddingDimensions(pool, dimensions)),
    migrationV2('20260718-027-postgres-embedding-dimension-repair', 'repair legacy embedding transition constraints and values', () => migrateEmbeddingDimensions(pool, dimensions)),
  ];
}

function migration(
  id: string,
  contract: string,
  run: () => Promise<void>,
  implementation: readonly string[] = artifactsFor(id),
): SchemaMigration {
  return withLegacyChecksums({
    id,
    contract: `csm-postgres-v1:${contract}`,
    implementation,
    run,
  }, historicalArtifactSetsFor(id, [implementation]));
}

function vectorExtension(pool: DatabasePool): () => Promise<void> {
  return () => pool.query('CREATE EXTENSION IF NOT EXISTS vector').then(() => undefined);
}

function migrationV2(
  id: string,
  contract: string,
  run: () => Promise<void>,
): SchemaMigration {
  return withLegacyChecksums({
    id,
    contract: `csm-postgres-v2:${contract}`,
    implementation: artifactsFor(id),
    run,
  }, historicalArtifactSetsFor(id));
}

function withLegacyChecksums(
  definition: SchemaMigration,
  historicalImplementations: readonly (readonly string[])[],
): SchemaMigration {
  const currentChecksum = migrationChecksum(definition);
  const acceptedLegacyChecksums = [...new Set(historicalImplementations
    .map((implementation) => migrationChecksum({ ...definition, implementation }))
    .filter((checksum) => checksum !== currentChecksum))];
  return acceptedLegacyChecksums.length === 0
    ? definition
    : { ...definition, acceptedLegacyChecksums };
}

function withAcceptedLegacy(
  definition: SchemaMigration,
  additionalChecksums: readonly string[],
): SchemaMigration {
  const existing = definition.acceptedLegacyChecksums ?? [];
  return { ...definition, acceptedLegacyChecksums: [...existing, ...additionalChecksums] };
}

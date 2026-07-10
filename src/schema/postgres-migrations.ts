import { initializeBeliefKnowledgeSchema } from '../belief-knowledge-schema.js';
import { initializeCandidateSchema } from '../candidate-schema.js';
import { initializeCheckpointSchema } from '../checkpoint-schema.js';
import { initializeContextCompilationSchema } from '../context-compilation-schema.js';
import { initializeContextCacheSchema } from '../context-cache-schema.js';
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
import { artifactsFor } from './migration-artifacts.js';
import type { SchemaMigration } from './migration-ledger.js';
import { initializeMemorySchema } from './memory-schema.js';
import { migrateProjectIsolation } from './project-isolation-schema.js';
import { initializeSessionSchema } from './session-schema.js';
import { initializeWorkLedgerSchema } from '../work-ledger-schema.js';

export function buildPostgresMigrations(
  database: Database,
  pool: DatabasePool,
): SchemaMigration[] {
  const graphDatabase = { dialect: database.dialect, getPool: () => pool };
  return [
    migration('20260709-001-vector-extension', 'pgvector extension', vectorExtension(pool), ['CREATE EXTENSION IF NOT EXISTS vector']),
    migration('20260709-002-session', 'sessions, events, and session contexts', () => initializeSessionSchema(pool)),
    migration('20260709-003-memory', 'memories, chunks, merges, search, and archive metadata', () => initializeMemorySchema(pool)),
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
  ];
}

function migration(
  id: string,
  contract: string,
  run: () => Promise<void>,
  implementation: readonly string[] = artifactsFor(id),
): SchemaMigration {
  return {
    id,
    contract: `csm-postgres-v1:${contract}`,
    implementation,
    run,
  };
}

function vectorExtension(pool: DatabasePool): () => Promise<void> {
  return () => pool.query('CREATE EXTENSION IF NOT EXISTS vector').then(() => undefined);
}

function migrationV2(
  id: string,
  contract: string,
  run: () => Promise<void>,
): SchemaMigration {
  return {
    id,
    contract: `csm-postgres-v2:${contract}`,
    implementation: artifactsFor(id),
    run,
  };
}

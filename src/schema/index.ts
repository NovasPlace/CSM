import { initializeCheckpointSchema } from '../checkpoint-schema.js';
import { initializeContextCompilationSchema } from '../context-compilation-schema.js';
import { initializeContextCacheSchema } from '../context-cache-schema.js';
import { initializeRolloverSchema } from '../context-rollover-schema.js';
import { initializeCrossSessionCausalSchema } from '../cross-session-causal-schema.js';
import type { Database } from '../database.js';
import { initializeGoalSchema } from '../goal-schema.js';
import { initializeGraphSchema } from '../memory-graph.js';
import { initializeRecallTelemetrySchema } from '../recall-telemetry.js';
import { initializeSelfContinuitySchema } from '../self-continuity-schema.js';
import { initializeTraceVaultSchema } from '../trace-vault-store.js';
import { initializeWorkJournalSchema } from '../work-journal-schema.js';
import { initializeCoreSchema } from './core-schema.js';
import { initializeMemorySchema } from './memory-schema.js';
import { migrateProjectIsolation } from './project-isolation-schema.js';
import { isOwnershipLimitedSchemaError } from './schema-errors.js';
import { initializeSessionSchema } from './session-schema.js';
import { getLogger } from '../logger.js';

export async function initializeAllSchemas(database: Database): Promise<void> {
  const pool = database.getPool();
  const provider = database.getProvider();
  const ownershipLimitedSteps: string[] = [];

  const steps: Array<[string, () => Promise<void>]> = [
    ['extension.vector', () => provider === 'sqlite' ? Promise.resolve() : pool.query('CREATE EXTENSION IF NOT EXISTS vector').then(() => undefined)],
    ['session', () => initializeSessionSchema(pool)],
    ['memory', () => initializeMemorySchema(pool)],
    ['core', () => initializeCoreSchema(pool)],
    ['project-isolation', () => migrateProjectIsolation(pool)],
    ['checkpoint', () => initializeCheckpointSchema(pool)],
    ['context-compilation', () => initializeContextCompilationSchema(pool)],
    ['context-cache', () => initializeContextCacheSchema(pool)],
    ['rollover', () => initializeRolloverSchema(pool)],
    ['goal', () => initializeGoalSchema(pool)],
    ['recall-telemetry', () => initializeRecallTelemetrySchema(pool)],
    ['self-continuity', () => initializeSelfContinuitySchema(pool)],
    ['cross-session-causal', () => initializeCrossSessionCausalSchema(pool)],
    ['trace-vault', () => initializeTraceVaultSchema(pool)],
    ['graph', () => initializeGraphSchema(database)],
    ['work-journal', () => initializeWorkJournalSchema(pool)],
  ];

  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
       if (isOwnershipLimitedSchemaError(error)) {
         ownershipLimitedSteps.push(name);
         continue;
       }
       getLogger().error(`Schema step failed (${name}); continuing`, error instanceof Error ? error : undefined);
     }
   }
 
   if (ownershipLimitedSteps.length > 0) {
     getLogger().info(`Schema steps skipped due to ownership limits: ${ownershipLimitedSteps.join(', ')}`);
   }
 }

import { CheckpointStore } from './checkpoint-store.js';
import { ContextCompactor } from './context-compactor.js';
import { ContextRecallDaemon } from './context-recall.js';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { DEFAULT_CONFIG, validatePluginConfig } from './config.js';
import { MemoryExtractor } from './memory-extractor.js';
import { MemoryManager } from './memory-manager.js';
import { PrimingEngine } from './priming-engine.js';
import { Redactor } from './redactor.js';
import type { BridgeDeps } from './bridge-ops.js';
import type { CodexBridgeExtraDeps } from './codex-bridge-extra-ops.js';
import { mergePluginConfig, normalizeProviderRuntimeConfig } from './provider-runtime-config.js';
import { StartupRollback } from './startup-rollback.js';
import type { RuntimePluginConfig } from './runtime-plugin-config.js';
import { WorkLedger } from './work-ledger.js';

export interface CodexBridgeRuntime {
  config: RuntimePluginConfig;
  deps: BridgeDeps & CodexBridgeExtraDeps;
  workLedger?: WorkLedger;
}

export interface CodexBridgeStartupBoundary<T = CodexBridgeRuntime> {
  afterDatabaseConnect?(database: Database): void | Promise<void>;
  beforeCommit?(runtime: CodexBridgeRuntime): void | Promise<void>;
  activate?(runtime: CodexBridgeRuntime): T | Promise<T>;
}

export async function createCodexBridgeRuntime<T = CodexBridgeRuntime>(
  options: Partial<RuntimePluginConfig> = {},
  boundary: CodexBridgeStartupBoundary<T> = {},
): Promise<T> {
  const config = normalizedConfig(options);
  const database = new Database(config);
  const rollback = new StartupRollback();
  try {
    await database.connect();
    rollback.defer('database close', () => database.close());
    await boundary.afterDatabaseConnect?.(database);
    const runtime = createRuntime(config, database);
    rollback.defer('Work Ledger', async () => runtime.workLedger?.dispose());
    await boundary.beforeCommit?.(runtime);
    const result = boundary.activate
      ? await boundary.activate(runtime) : runtime as unknown as T;
    rollback.commit();
    return result;
  } catch (error) {
    return rollback.fail(error);
  }
}

function normalizedConfig(options: Partial<RuntimePluginConfig>): RuntimePluginConfig {
  const configured = mergePluginConfig(
    DEFAULT_CONFIG, options as unknown as Record<string, unknown>,
  );
  return normalizeProviderRuntimeConfig(validatePluginConfig(configured));
}

function createRuntime(config: RuntimePluginConfig, database: Database): CodexBridgeRuntime {
  const redactor = new Redactor(config.redactor);
  const embeddings = new EmbeddingGenerator(config);
  const memoryManager = new MemoryManager(database, embeddings, redactor);
  const deps = {
    database, memoryManager,
    contextRecall: new ContextRecallDaemon(database, config.contextRecallInterval),
    primingEngine: new PrimingEngine(database),
    contextCompactor: new ContextCompactor(config.compactor),
    memoryExtractor: new MemoryExtractor(database, memoryManager, config.extractor),
    checkpointStore: new CheckpointStore(database.getPool(), redactor),
    checkpointConfig: config.checkpoint, distillerConfig: config.distiller,
  };
  const workLedger = config.workLedger.enabled
    ? new WorkLedger(database.getPool(), config.workLedger) : undefined;
  return { config, deps, workLedger };
}

import type { PluginConfig } from './types.js';
import { getEnvBoolean, getEnvInteger, getEnvNumber } from './config-env.js';
import { databaseSettingsFromEnv, embeddingSettingsFromEnv } from './config-provider.js';

type BaseDefaults = Pick<PluginConfig,
  'databaseUrl' | 'databaseProvider' | 'sqlitePath' | 'databaseRuntime' | 'workLedger'
  | 'embeddingModel' | 'embeddingApiKey' | 'embeddingApiUrl' | 'maxMemoriesPerRecall'
  | 'importanceThreshold' | 'autoStoreConversations' | 'fullTranscripts'
  | 'contextRecallInterval' | 'subconsciousWatchInterval' | 'gitPollInterval'
  | 'contextPressureRecommend' | 'contextPressureDemand' | 'targetContextCap'
  | 'loopDetectionThreshold' | 'logToolUsage' | 'logCommands' | 'logSessionLifecycle'
  | 'filterBuildArtifacts' | 'promptDebug' | 'extractor' | 'ttl' | 'distiller'
  | 'compactor' | 'assistantCompactor' | 'checkpoint'> & { embeddingDimensions: number };

export function baseDefaultsFromEnv(): BaseDefaults {
  return {
    ...databaseSettingsFromEnv(),
    ...embeddingSettingsFromEnv(),
    workLedger: workLedgerDefaults(),
    maxMemoriesPerRecall: getEnvInteger('CSM_MAX_MEMORIES_PER_RECALL', 10),
    importanceThreshold: getEnvNumber('CSM_IMPORTANCE_THRESHOLD', 0.3),
    autoStoreConversations: getEnvBoolean('CSM_AUTO_STORE_CONVERSATIONS', true),
    fullTranscripts: getEnvBoolean('CSM_FULL_TRANSCRIPTS', true),
    contextRecallInterval: getEnvInteger('CSM_CONTEXT_RECALL_INTERVAL', 90),
    subconsciousWatchInterval: getEnvInteger('CSM_SUBCONSCIOUS_WATCH_INTERVAL', 30),
    gitPollInterval: getEnvInteger('CSM_GIT_POLL_INTERVAL', 60),
    contextPressureRecommend: getEnvNumber('CSM_CONTEXT_PRESSURE_RECOMMEND', 0.65),
    contextPressureDemand: getEnvNumber('CSM_CONTEXT_PRESSURE_DEMAND', 0.85),
    targetContextCap: getEnvInteger('CSM_TARGET_CONTEXT_CAP', 50_000),
    loopDetectionThreshold: getEnvInteger('CSM_LOOP_DETECTION_THRESHOLD', 3),
    logToolUsage: getEnvBoolean('CSM_LOG_TOOL_USAGE', false),
    logCommands: getEnvBoolean('CSM_LOG_COMMANDS', false),
    logSessionLifecycle: getEnvBoolean('CSM_LOG_SESSION_LIFECYCLE', false),
    filterBuildArtifacts: getEnvBoolean('CSM_FILTER_BUILD_ARTIFACTS', true),
    promptDebug: getEnvBoolean('CSM_PROMPT_DEBUG', false),
    extractor: extractorDefaults(), ttl: ttlDefaults(), distiller: distillerDefaults(),
    compactor: compactorDefaults(), assistantCompactor: assistantCompactorDefaults(),
    checkpoint: checkpointDefaults(),
  };
}

function workLedgerDefaults(): PluginConfig['workLedger'] {
  return {
    enabled: getEnvBoolean('CSM_WORK_LEDGER_ENABLED', true),
    maxFileBytes: getEnvInteger('CSM_WORK_LEDGER_MAX_FILE_BYTES', 5_000_000),
    captureTimeoutMs: getEnvInteger('CSM_WORK_LEDGER_CAPTURE_TIMEOUT_MS', 300_000),
  };
}

function extractorDefaults(): PluginConfig['extractor'] {
  return {
    enabled: true,
    minTurnsBeforeExtract: getEnvInteger('CSM_EXTRACTOR_MIN_TURNS', 3),
    maxCandidatesPerTurn: getEnvInteger('CSM_EXTRACTOR_MAX_CANDIDATES', 5),
    confidenceThreshold: getEnvNumber('CSM_EXTRACTOR_CONFIDENCE_THRESHOLD', 0.7),
    autoApproveThreshold: getEnvNumber('CSM_EXTRACTOR_AUTO_APPROVE_THRESHOLD', 0.9),
  };
}

function ttlDefaults(): PluginConfig['ttl'] {
  return {
    enabled: true,
    defaultDays: getEnvInteger('CSM_TTL_DEFAULT_DAYS', 90),
    byType: {
      conversation: getEnvInteger('CSM_TTL_CONVERSATION', 60),
      workspace: getEnvInteger('CSM_TTL_WORKSPACE', 30), repo: getEnvInteger('CSM_TTL_REPO', 45),
      preference: getEnvInteger('CSM_TTL_PREFERENCE', 180), lesson: getEnvInteger('CSM_TTL_LESSON', 365),
      episodic: getEnvInteger('CSM_TTL_EPISODIC', 7), procedural: getEnvInteger('CSM_TTL_PROCEDURAL', 30),
    },
    byImportance: [
      { min: 0, max: 0.3, days: getEnvInteger('CSM_TTL_IMPORTANCE_0_3', 180) },
      { min: 0.3, max: 0.6, days: getEnvInteger('CSM_TTL_IMPORTANCE_0_6', 90) },
      { min: 0.6, max: 1, days: getEnvInteger('CSM_TTL_IMPORTANCE_0_10', 30) },
    ],
    gracePeriodDays: getEnvInteger('CSM_TTL_GRACE_PERIOD', 7),
  };
}

function distillerDefaults(): PluginConfig['distiller'] {
  return {
    enabled: true,
    groupWindowMs: getEnvInteger('CSM_DISTILLER_GROUP_WINDOW', 30_000),
    maxSummaryLength: getEnvInteger('CSM_DISTILLER_MAX_LENGTH', 200),
    maxContextSummaries: getEnvInteger('CSM_DISTILLER_MAX_SUMMARIES', 10),
    minCallsForGroup: getEnvInteger('CSM_DISTILLER_MIN_CALLS', 2),
    autoSaveAsMemory: getEnvBoolean('CSM_DISTILLER_AUTO_SAVE', true),
  };
}

function compactorDefaults(): PluginConfig['compactor'] {
  return {
    enabled: true,
    workingMemoryWindow: getEnvInteger('CSM_COMPACTOR_WORKING_WINDOW', 8),
    minAgeMs: getEnvInteger('CSM_COMPACTOR_MIN_AGE', 60_000),
    maxOutputChars: getEnvInteger('CSM_COMPACTOR_MAX_OUTPUT', 120),
    truncateInput: getEnvBoolean('CSM_COMPACTOR_TRUNCATE', true),
    budgetCapEnabled: getEnvBoolean('CSM_COMPACTOR_BUDGET_CAP', true),
    budgetCapPercent: getEnvNumber('CSM_COMPACTOR_BUDGET_PERCENT', 25),
    budgetCapPressureThreshold: getEnvNumber('CSM_COMPACTOR_PRESSURE_THRESHOLD', 0.6),
    budgetCapMaxIterations: getEnvInteger('CSM_COMPACTOR_MAX_ITERATIONS', 3),
  };
}

function assistantCompactorDefaults(): PluginConfig['assistantCompactor'] {
  return {
    enabled: true,
    workingAssistantWindow: getEnvInteger('CSM_ASSISTANT_COMPACTOR_WINDOW', 2),
    minTokens: getEnvInteger('CSM_ASSISTANT_COMPACTOR_MIN_TOKENS', 800),
    maxOutputChars: getEnvInteger('CSM_ASSISTANT_COMPACTOR_MAX_OUTPUT', 600),
  };
}

function checkpointDefaults(): PluginConfig['checkpoint'] {
  return {
    enabled: true,
    maxCheckpointInjectTokens: getEnvInteger('CSM_CHECKPOINT_MAX_INJECT_TOKENS', 1_200),
    minMessagesBeforeInject: getEnvInteger('CSM_CHECKPOINT_MIN_MESSAGES', 10),
    maxRawCapturesPerCheckpoint: getEnvInteger('CSM_CHECKPOINT_MAX_CAPTURES', 50),
    maxRawCaptureBytes: getEnvInteger('CSM_CHECKPOINT_MAX_BYTES', 4_096),
    auto: {
      enabled: true,
      contextPressureThreshold: getEnvNumber('CSM_CHECKPOINT_PRESSURE_THRESHOLD', 0.8),
      messageCountThreshold: getEnvInteger('CSM_CHECKPOINT_MESSAGE_THRESHOLD', 50),
      riskyEditToolPatterns: ['write', 'edit', 'delete', 'patch'],
    },
  };
}

import { PluginConfig } from './types.js';
import { DEFAULT_GOVERNOR_CONFIG } from './context-governor-profiles.js';
import { DEFAULT_ROLLOVER_CONFIG } from './context-rollover-config.js';

// Helper to read environment variables with defaults
function getEnvString(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

function getEnvBoolean(key: string, defaultValue: boolean = false): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

function getEnvNumber(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

// Determine if we're in production mode (strict mode)
const isProduction = getEnvBoolean('CSM_REQUIRE_EXPLICIT_DATABASE_URL', false);

// Database provider selection
function getDatabaseProvider(): 'postgres' | 'sqlite' {
  const provider = process.env['CSM_DATABASE_PROVIDER'] ?? 'postgres';
  if (provider !== 'postgres' && provider !== 'sqlite') {
    throw new Error(`Invalid CSM_DATABASE_PROVIDER: "${provider}". Must be "postgres" or "sqlite"`);
  }
  return provider;
}

// SQLite path
function getSqlitePath(): string {
  return process.env['CSM_SQLITE_PATH'] ?? '.data/csm-memory.db';
}

// Database URL handling: optional in dev/test, required in production
function getDatabaseUrl(): string {
  const explicitUrl = getEnvString('CSM_DATABASE_URL');
  if (explicitUrl) {
    return explicitUrl;
  }
  // Development/test mode: default to localhost
  return 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';
}

// Provider configuration
function getEmbeddingProvider(): string {
  return process.env['CSM_EMBEDDING_PROVIDER'] ?? 'ollama';
}

function getOpenAIApiKey(): string | undefined {
  return getEnvString('OPENAI_API_KEY');
}

function getOllamaHost(): string {
  return process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
}

// Validate configuration
function validateConfig(config: PluginConfig): void {
  // Production requires explicit database URL (only for postgres provider)
  if (isProduction && config.databaseProvider === 'postgres' && !process.env['CSM_DATABASE_URL']) {
    throw new Error('CSM_DATABASE_URL is required in production mode');
  }

  // Validate embedding provider
  const provider = getEmbeddingProvider();
  if (provider !== 'ollama' && provider !== 'openai') {
    throw new Error(`Invalid CSM_EMBEDDING_PROVIDER: "${provider}". Must be "ollama" or "openai"`);
  }

  // Validate TTL ranges
  const ttl = config.ttl;
  if (ttl.defaultDays < 1 || ttl.defaultDays > 365) {
    throw new Error('CSM_TTL_DEFAULT_DAYS must be between 1 and 365');
  }
}

// Default configuration for the Cross-Session Memory Plugin
export const DEFAULT_CONFIG: PluginConfig = {
  databaseUrl: getDatabaseUrl(),
  databaseProvider: getDatabaseProvider(),
  sqlitePath: getSqlitePath(),
  embeddingModel: getEmbeddingProvider() === 'openai' ? 'text-embedding-3-small' : 'nomic-embed-text',
  embeddingApiKey: getEmbeddingProvider() === 'openai' ? getOpenAIApiKey() : undefined,
  embeddingApiUrl: getEmbeddingProvider() === 'ollama' ? getOllamaHost() : undefined,
  maxMemoriesPerRecall: getEnvNumber('CSM_MAX_MEMORIES_PER_RECALL', 10),
  importanceThreshold: getEnvNumber('CSM_IMPORTANCE_THRESHOLD', 0.3),
  autoStoreConversations: getEnvBoolean('CSM_AUTO_STORE_CONVERSATIONS', true),
  fullTranscripts: getEnvBoolean('CSM_FULL_TRANSCRIPTS', true),
  contextRecallInterval: getEnvNumber('CSM_CONTEXT_RECALL_INTERVAL', 90),
  subconsciousWatchInterval: getEnvNumber('CSM_SUBCONSCIOUS_WATCH_INTERVAL', 30),
  gitPollInterval: getEnvNumber('CSM_GIT_POLL_INTERVAL', 60),
  contextPressureRecommend: getEnvNumber('CSM_CONTEXT_PRESSURE_RECOMMEND', 0.65),
  contextPressureDemand: getEnvNumber('CSM_CONTEXT_PRESSURE_DEMAND', 0.85),
  loopDetectionThreshold: getEnvNumber('CSM_LOOP_DETECTION_THRESHOLD', 3),
  logToolUsage: getEnvBoolean('CSM_LOG_TOOL_USAGE', false),
  logCommands: getEnvBoolean('CSM_LOG_COMMANDS', false),
  logSessionLifecycle: getEnvBoolean('CSM_LOG_SESSION_LIFECYCLE', false),
  filterBuildArtifacts: getEnvBoolean('CSM_FILTER_BUILD_ARTIFACTS', true),
  promptDebug: getEnvBoolean('CSM_PROMPT_DEBUG', false),
  extractor: {
    enabled: true,
    minTurnsBeforeExtract: getEnvNumber('CSM_EXTRACTOR_MIN_TURNS', 3),
    maxCandidatesPerTurn: getEnvNumber('CSM_EXTRACTOR_MAX_CANDIDATES', 5),
    confidenceThreshold: getEnvNumber('CSM_EXTRACTOR_CONFIDENCE_THRESHOLD', 0.7),
    autoApproveThreshold: getEnvNumber('CSM_EXTRACTOR_AUTO_APPROVE_THRESHOLD', 0.9),
  },
  ttl: {
    enabled: true,
    defaultDays: getEnvNumber('CSM_TTL_DEFAULT_DAYS', 90),
    byType: {
      'conversation': getEnvNumber('CSM_TTL_CONVERSATION', 60),
      'workspace': getEnvNumber('CSM_TTL_WORKSPACE', 30),
      'repo': getEnvNumber('CSM_TTL_REPO', 45),
      'preference': getEnvNumber('CSM_TTL_PREFERENCE', 180),
      'lesson': getEnvNumber('CSM_TTL_LESSON', 365),
      'episodic': getEnvNumber('CSM_TTL_EPISODIC', 7),
      'procedural': getEnvNumber('CSM_TTL_PROCEDURAL', 30),
    },
    byImportance: [
      { min: 0, max: 0.3, days: getEnvNumber('CSM_TTL_IMPORTANCE_0_3', 180) },
      { min: 0.3, max: 0.6, days: getEnvNumber('CSM_TTL_IMPORTANCE_0_6', 90) },
      { min: 0.6, max: 1.0, days: getEnvNumber('CSM_TTL_IMPORTANCE_0_10', 30) },
    ],
    gracePeriodDays: getEnvNumber('CSM_TTL_GRACE_PERIOD', 7),
  },
  distiller: {
    enabled: true,
    groupWindowMs: getEnvNumber('CSM_DISTILLER_GROUP_WINDOW', 30000),
    maxSummaryLength: getEnvNumber('CSM_DISTILLER_MAX_LENGTH', 200),
    maxContextSummaries: getEnvNumber('CSM_DISTILLER_MAX_SUMMARIES', 10),
    minCallsForGroup: getEnvNumber('CSM_DISTILLER_MIN_CALLS', 2),
    autoSaveAsMemory: getEnvBoolean('CSM_DISTILLER_AUTO_SAVE', true),
  },
  compactor: {
    enabled: true,
    workingMemoryWindow: getEnvNumber('CSM_COMPACTOR_WORKING_WINDOW', 8),
    minAgeMs: getEnvNumber('CSM_COMPACTOR_MIN_AGE', 60000),
    maxOutputChars: getEnvNumber('CSM_COMPACTOR_MAX_OUTPUT', 120),
    truncateInput: getEnvBoolean('CSM_COMPACTOR_TRUNCATE', true),
    budgetCapEnabled: getEnvBoolean('CSM_COMPACTOR_BUDGET_CAP', true),
    budgetCapPercent: getEnvNumber('CSM_COMPACTOR_BUDGET_PERCENT', 30),
    budgetCapPressureThreshold: getEnvNumber('CSM_COMPACTOR_PRESSURE_THRESHOLD', 0.7),
    budgetCapMaxIterations: getEnvNumber('CSM_COMPACTOR_MAX_ITERATIONS', 3),
  },
  assistantCompactor: {
    enabled: true,
    workingAssistantWindow: getEnvNumber('CSM_ASSISTANT_COMPACTOR_WINDOW', 2),
    minTokens: getEnvNumber('CSM_ASSISTANT_COMPACTOR_MIN_TOKENS', 800),
    maxOutputChars: getEnvNumber('CSM_ASSISTANT_COMPACTOR_MAX_OUTPUT', 600),
  },
  checkpoint: {
    enabled: true,
    maxCheckpointInjectTokens: getEnvNumber('CSM_CHECKPOINT_MAX_INJECT_TOKENS', 1200),
    minMessagesBeforeInject: getEnvNumber('CSM_CHECKPOINT_MIN_MESSAGES', 10),
    maxRawCapturesPerCheckpoint: getEnvNumber('CSM_CHECKPOINT_MAX_CAPTURES', 50),
    maxRawCaptureBytes: getEnvNumber('CSM_CHECKPOINT_MAX_BYTES', 4096),
    auto: {
      enabled: true,
      contextPressureThreshold: getEnvNumber('CSM_CHECKPOINT_PRESSURE_THRESHOLD', 0.8),
      messageCountThreshold: getEnvNumber('CSM_CHECKPOINT_MESSAGE_THRESHOLD', 50),
      riskyEditToolPatterns: ['write', 'edit', 'delete', 'patch'],
    },
  },
  contextCompiler: {
    enabled: true,
    modes: { cheap: getEnvNumber('CSM_COMPILER_MODE_CHEAP', 35000), normal: getEnvNumber('CSM_COMPILER_MODE_NORMAL', 50000), deep: getEnvNumber('CSM_COMPILER_MODE_DEEP', 75000) },
    defaultMode: 'normal',
    recentTurnWindow: getEnvNumber('CSM_COMPILER_RECENT_WINDOW', 3),
    // Layer 1: status line injection (telemetry only, no instructions)
    statusInjection: true,
    statusPlacement: 'end',
    statusVerbosity: 'compact',
    // Layer 3: compilation log retention
    logEnabled: true,
    logSummaryRetentionDays: null,  // keep stats forever
    logDetailsRetentionDays: getEnvNumber('CSM_COMPILER_LOG_DETAILS_DAYS', 60),    // prune JSONB details after 60 days
    storeRawCompressedContent: false,
  },
  contextGovernor: DEFAULT_GOVERNOR_CONFIG,
  contextCache: {
    enabled: true,
    minTokensToCache: getEnvNumber('CSM_CACHE_MIN_TOKENS', 100),
    manifestMaxTokens: getEnvNumber('CSM_CACHE_MANIFEST_TOKENS', 1000),
    retentionDays: getEnvNumber('CSM_CACHE_RETENTION_DAYS', 30),
  },
  contextRollover: DEFAULT_ROLLOVER_CONFIG,
  // Agent work journal — live incremental capture of agent's work state
  workJournal: {
    enabled: true,
    maxResumeEntries: getEnvNumber('CSM_WORKJOURNAL_MAX_RESUME', 20),
    maxIntentChars: getEnvNumber('CSM_WORKJOURNAL_MAX_INTENT', 200),
    injectMaxTokens: getEnvNumber('CSM_WORKJOURNAL_INJECT_TOKENS', 800),
    autoMarkMilestone: getEnvBoolean('CSM_WORKJOURNAL_AUTO_MILESTONE', true),
    persistOnDispose: getEnvBoolean('CSM_WORKJOURNAL_PERSIST', true),
  },
  autoDocs: {
    enabled: true,
    ignoredPaths: ["docs/", "dist/", "node_modules/", "coverage/", ".git/"],
    maxChangelogEntriesPerSession: getEnvNumber('CSM_AUTODOCS_MAX_ENTRIES', 50),
    maxEntryLength: getEnvNumber('CSM_AUTODOCS_MAX_LENGTH', 200),
    deduplicateEdits: getEnvBoolean('CSM_AUTODOCS_DEDUPLICATE', true),
    groupMultipleEdits: getEnvBoolean('CSM_AUTODOCS_GROUP', true),
  },
  redactor: {
    enabled: true,
    categories: {
      secret: true,
      email: true,
      phone: true,
      ip: true,
      urlCreds: true,
      path: 'normalize' as const,
    },
    workspaceRoot: getEnvString('CSM_WORKSPACE_ROOT'),
  },
  selfContinuity: {
    enabled: true,
    maxRecordsPerSession: 3,
    maxRecordsToInject: 3,
    maxInjectTokens: 600,
    injectionMode: 'silent',
    confidenceWeights: {
      recalledSessions: 0.30,
      evidenceAnchors: 0.25,
      goalContinuity: 0.20,
      selfSummarySimilarity: 0.15,
      selfAssessment: 0.10,
    },
    injectionTriggers: [
      'user_asks_about_memory',
      'session_resume',
      'alchemist_enabled',
      'checkpoint_resume',
    ],
    deepContinuity: {
      enabled: true,
      maxThreadsToInject: 3,
      maxInjectTokens: 1500,
      triggerKeywords: [
        'continuity',
        'memory',
        'identity',
        'growth',
        'past self',
        'past session',
        'previous session',
        'cross-session',
        'causal thread',
        'what changed',
        'how have i',
        'what have i learned',
      ],
      injectionMode: 'deep',
    },
  },
};

// Validate configuration at startup
export function validateAndReturnConfig(): PluginConfig {
  validateConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

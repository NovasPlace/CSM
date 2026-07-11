import type { PluginConfig } from './types.js';
import { DEFAULT_GOVERNOR_CONFIG } from './context-governor-profiles.js';
import { DEFAULT_ROLLOVER_CONFIG } from './context-rollover-config.js';
import { getEnvBoolean, getEnvInteger, getEnvNumber, getEnvString } from './config-env.js';

type ContinuityDefaults = Pick<PluginConfig,
  'contextCompiler' | 'contextGovernor' | 'contextCache' | 'contextRollover'
  | 'workJournal' | 'autoDocs' | 'redactor' | 'selfModel' | 'beliefKnowledge'
  | 'beliefPromotion' | 'livingState' | 'reentry' | 'selfContinuity'>;

export function continuityDefaultsFromEnv(): ContinuityDefaults {
  return {
    contextCompiler: compilerDefaults(),
    contextGovernor: DEFAULT_GOVERNOR_CONFIG,
    contextCache: cacheDefaults(),
    contextRollover: DEFAULT_ROLLOVER_CONFIG,
    workJournal: journalDefaults(),
    autoDocs: autoDocsDefaults(),
    redactor: redactorDefaults(),
    selfModel: selfModelDefaults(),
    beliefKnowledge: beliefKnowledgeDefaults(),
    beliefPromotion: beliefPromotionDefaults(),
    livingState: livingStateDefaults(),
    reentry: reentryDefaults(),
    selfContinuity: selfContinuityDefaults(),
  };
}

function compilerDefaults(): PluginConfig['contextCompiler'] {
  return {
    enabled: true,
    modes: {
      cheap: getEnvInteger('CSM_COMPILER_MODE_CHEAP', 35_000),
      normal: getEnvInteger('CSM_COMPILER_MODE_NORMAL', 50_000),
      deep: getEnvInteger('CSM_COMPILER_MODE_DEEP', 75_000),
    },
    defaultMode: 'normal', recentTurnWindow: getEnvInteger('CSM_COMPILER_RECENT_WINDOW', 3),
    statusInjection: true, statusPlacement: 'end', statusVerbosity: 'compact',
    logEnabled: true, logSummaryRetentionDays: null,
    logDetailsRetentionDays: getEnvInteger('CSM_COMPILER_LOG_DETAILS_DAYS', 60),
    storeRawCompressedContent: false,
  };
}

function cacheDefaults(): PluginConfig['contextCache'] {
  return {
    enabled: true,
    minTokensToCache: getEnvInteger('CSM_CACHE_MIN_TOKENS', 100),
    manifestMaxTokens: getEnvInteger('CSM_CACHE_MANIFEST_TOKENS', 1_000),
    retentionDays: getEnvInteger('CSM_CACHE_RETENTION_DAYS', 30),
  };
}

function journalDefaults(): PluginConfig['workJournal'] {
  return {
    enabled: true,
    maxResumeEntries: getEnvInteger('CSM_WORKJOURNAL_MAX_RESUME', 20),
    maxIntentChars: getEnvInteger('CSM_WORKJOURNAL_MAX_INTENT', 200),
    injectMaxTokens: getEnvInteger('CSM_WORKJOURNAL_INJECT_TOKENS', 800),
    autoMarkMilestone: getEnvBoolean('CSM_WORKJOURNAL_AUTO_MILESTONE', true),
    persistOnDispose: getEnvBoolean('CSM_WORKJOURNAL_PERSIST', true),
  };
}

function autoDocsDefaults(): PluginConfig['autoDocs'] {
  return {
    enabled: true,
    ignoredPaths: ['docs/', 'dist/', 'node_modules/', 'coverage/', '.git/'],
    maxChangelogEntriesPerSession: getEnvInteger('CSM_AUTODOCS_MAX_ENTRIES', 50),
    maxEntryLength: getEnvInteger('CSM_AUTODOCS_MAX_LENGTH', 200),
    deduplicateEdits: getEnvBoolean('CSM_AUTODOCS_DEDUPLICATE', true),
    groupMultipleEdits: getEnvBoolean('CSM_AUTODOCS_GROUP', true),
  };
}

function redactorDefaults(): PluginConfig['redactor'] {
  return {
    enabled: true,
    categories: { secret: true, email: true, phone: true, ip: true, urlCreds: true, path: 'normalize' },
    workspaceRoot: getEnvString('CSM_WORKSPACE_ROOT'),
  };
}

function selfModelDefaults(): PluginConfig['selfModel'] {
  return {
    enabled: getEnvBoolean('CSM_SELF_MODEL_ENABLED', true),
    updateIntervalMs: getEnvInteger('CSM_SELF_MODEL_UPDATE_INTERVAL', 60_000),
    confidenceIncrementRate: getEnvNumber('CSM_SELF_MODEL_CONFIDENCE_RATE', 10) / 100,
    uncertaintyIncrementRate: getEnvNumber('CSM_SELF_MODEL_UNCERTAINTY_RATE', 15) / 100,
    contradictionPenalty: getEnvNumber('CSM_SELF_MODEL_CONTRADICTION_PENALTY', 10) / 100,
    driftWarningThreshold: getEnvNumber('CSM_SELF_MODEL_DRIFT_THRESHOLD', 70) / 100,
  };
}

function beliefKnowledgeDefaults(): PluginConfig['beliefKnowledge'] {
  return {
    enabled: getEnvBoolean('CSM_BELIEF_KNOWLEDGE_ENABLED', true),
    consolidationIntervalMs: getEnvInteger('CSM_BELIEF_KNOWLEDGE_INTERVAL', 120_000),
    confidenceThreshold: getEnvNumber('CSM_BELIEF_KNOWLEDGE_CONFIDENCE_THRESHOLD', 50) / 100,
    uncertaintyThreshold: getEnvNumber('CSM_BELIEF_KNOWLEDGE_UNCERTAINTY_THRESHOLD', 60) / 100,
  };
}

function beliefPromotionDefaults(): PluginConfig['beliefPromotion'] {
  return {
    enabled: getEnvBoolean('CSM_BELIEF_PROMOTION_ENABLED', false),
    dryRunByDefault: getEnvBoolean('CSM_BELIEF_PROMOTION_DRY_RUN', true),
    minConfidence: getEnvNumber('CSM_BELIEF_PROMOTION_MIN_CONFIDENCE', 70) / 100,
    minReinforcement: getEnvInteger('CSM_BELIEF_PROMOTION_MIN_REINFORCEMENT', 3),
    minEvidenceRefs: getEnvInteger('CSM_BELIEF_PROMOTION_MIN_EVIDENCE_REFS', 2),
    minSessions: getEnvInteger('CSM_BELIEF_PROMOTION_MIN_SESSIONS', 1),
    maxPromotePerRun: getEnvInteger('CSM_BELIEF_PROMOTION_MAX_PROMOTE', 10),
    relaxed: getEnvBoolean('CSM_BELIEF_PROMOTION_RELAXED', false),
  };
}

function livingStateDefaults(): PluginConfig['livingState'] {
  return {
    enabled: getEnvBoolean('CSM_LIVING_STATE_ENABLED', true),
    previewOnly: getEnvBoolean('CSM_LIVING_STATE_PREVIEW_ONLY', true),
    injectAdvisoryBlock: getEnvBoolean('CSM_LIVING_STATE_INJECT_ADVISORY', true),
    maxAdvisoryBlockChars: getEnvInteger('CSM_LIVING_STATE_MAX_ADVISORY_CHARS', 600),
    scanLookbackMinutes: getEnvInteger('CSM_LIVING_STATE_LOOKBACK_MINUTES', 10),
    maxScanPerType: getEnvInteger('CSM_LIVING_STATE_MAX_PER_TYPE', 10),
    updateIntervalMs: getEnvInteger('CSM_LIVING_STATE_INTERVAL', 60_000),
  };
}

function reentryDefaults(): PluginConfig['reentry'] {
  return {
    enabled: getEnvBoolean('CSM_REENTRY_ENABLED', true),
    maxChars: getEnvInteger('CSM_REENTRY_MAX_CHARS', 2_100),
    previewOnly: getEnvBoolean('CSM_REENTRY_PREVIEW_ONLY', false),
    minLayerChars: getEnvInteger('CSM_REENTRY_MIN_LAYER_CHARS', 50),
    layers: ['identity', 'goals', 'work', 'preferences', 'capabilities', 'beliefs', 'recent', 'constraints'],
  };
}

function selfContinuityDefaults(): PluginConfig['selfContinuity'] {
  return {
    enabled: true, maxRecordsPerSession: 3, maxRecordsToInject: 3,
    maxInjectTokens: 600, injectionMode: 'silent',
    confidenceWeights: {
      recalledSessions: 0.30, evidenceAnchors: 0.25, goalContinuity: 0.20,
      selfSummarySimilarity: 0.15, selfAssessment: 0.10,
    },
    injectionTriggers: [
      'user_asks_about_memory', 'session_resume', 'alchemist_enabled', 'checkpoint_resume',
    ],
    deepContinuity: deepContinuityDefaults(),
  };
}

function deepContinuityDefaults(): PluginConfig['selfContinuity']['deepContinuity'] {
  return {
    enabled: true, maxThreadsToInject: 3, maxInjectTokens: 1_500,
    triggerKeywords: [
      'continuity', 'memory', 'identity', 'growth', 'past self', 'past session',
      'previous session', 'cross-session', 'causal thread', 'what changed',
      'how have i', 'what have i learned',
    ],
    injectionMode: 'deep',
  };
}

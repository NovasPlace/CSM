import type { PluginConfig } from './types.js';

export type ConfigRange = readonly [
  name: string,
  value: number,
  min: number,
  max: number,
  integer?: boolean,
];

const COUNT_MAX = 1_000_000;
const SIZE_MAX = 100_000_000;
const TIMER_MAX = 2_147_483_647;

export function allConfigRanges(config: PluginConfig): ConfigRange[] {
  return [
    ...coreRanges(config), ...extractorAndTtlRanges(config),
    ...compactionRanges(config), ...checkpointAndCompilerRanges(config),
    ...continuityRanges(config), ...livingStateRanges(config),
  ];
}

function coreRanges(config: PluginConfig): ConfigRange[] {
  return [
    ['CSM_WORK_LEDGER_MAX_FILE_BYTES', config.workLedger.maxFileBytes, 1_024, SIZE_MAX, true],
    ['CSM_WORK_LEDGER_CAPTURE_TIMEOUT_MS', config.workLedger.captureTimeoutMs, 1_000, 3_600_000, true],
    ['maxMemoriesPerRecall', config.maxMemoriesPerRecall, 1, 10_000, true],
    ['importanceThreshold', config.importanceThreshold, 0, 1],
    ['contextRecallInterval', config.contextRecallInterval, 1, 86_400, true],
    ['subconsciousWatchInterval', config.subconsciousWatchInterval, 1, 86_400, true],
    ['gitPollInterval', config.gitPollInterval, 1, 86_400, true],
    ['contextPressureRecommend', config.contextPressureRecommend, 0, 1],
    ['contextPressureDemand', config.contextPressureDemand, 0, 1],
    ['targetContextCap', config.targetContextCap, 1_000, 10_000_000, true],
    ['loopDetectionThreshold', config.loopDetectionThreshold, 1, COUNT_MAX, true],
  ];
}

function extractorAndTtlRanges(config: PluginConfig): ConfigRange[] {
  const ttlDays = Object.entries(config.ttl.byType).map(([type, days]) =>
    [`ttl.byType.${type}`, days, 1, 3_650, true] as const);
  const importanceDays = config.ttl.byImportance.map((range, index) =>
    [`ttl.byImportance.${index}.days`, range.days, 1, 3_650, true] as const);
  return [
    ['extractor.minTurnsBeforeExtract', config.extractor.minTurnsBeforeExtract, 0, COUNT_MAX, true],
    ['extractor.maxCandidatesPerTurn', config.extractor.maxCandidatesPerTurn, 1, COUNT_MAX, true],
    ['extractor.confidenceThreshold', config.extractor.confidenceThreshold, 0, 1],
    ['extractor.autoApproveThreshold', config.extractor.autoApproveThreshold, 0, 1],
    ['ttl.defaultDays', config.ttl.defaultDays, 1, 365, true],
    ['ttl.gracePeriodDays', config.ttl.gracePeriodDays, 0, 3_650, true],
    ...ttlDays, ...importanceDays,
  ];
}

function compactionRanges(config: PluginConfig): ConfigRange[] {
  return [
    ['distiller.groupWindowMs', config.distiller.groupWindowMs, 1, TIMER_MAX, true],
    ['distiller.maxSummaryLength', config.distiller.maxSummaryLength, 1, SIZE_MAX, true],
    ['distiller.maxContextSummaries', config.distiller.maxContextSummaries, 1, COUNT_MAX, true],
    ['distiller.minCallsForGroup', config.distiller.minCallsForGroup, 1, COUNT_MAX, true],
    ['compactor.workingMemoryWindow', config.compactor.workingMemoryWindow, 0, COUNT_MAX, true],
    ['compactor.minAgeMs', config.compactor.minAgeMs, 0, TIMER_MAX, true],
    ['compactor.maxOutputChars', config.compactor.maxOutputChars, 1, SIZE_MAX, true],
    ['compactor.budgetCapPercent', config.compactor.budgetCapPercent, 0, 100],
    ['compactor.budgetCapPressureThreshold', config.compactor.budgetCapPressureThreshold, 0, 1],
    ['compactor.budgetCapMaxIterations', config.compactor.budgetCapMaxIterations, 1, COUNT_MAX, true],
    ['assistantCompactor.workingAssistantWindow', config.assistantCompactor.workingAssistantWindow, 0, COUNT_MAX, true],
    ['assistantCompactor.minTokens', config.assistantCompactor.minTokens, 1, 10_000_000, true],
    ['assistantCompactor.maxOutputChars', config.assistantCompactor.maxOutputChars, 1, SIZE_MAX, true],
  ];
}

function checkpointAndCompilerRanges(config: PluginConfig): ConfigRange[] {
  const auto = config.checkpoint.auto;
  const autoRanges: ConfigRange[] = auto ? [
    ['checkpoint.auto.contextPressureThreshold', auto.contextPressureThreshold ?? 0.8, 0, 1],
    ['checkpoint.auto.messageCountThreshold', auto.messageCountThreshold ?? 50, 1, COUNT_MAX, true],
  ] : [];
  return [
    ['checkpoint.maxCheckpointInjectTokens', config.checkpoint.maxCheckpointInjectTokens, 1, 10_000_000, true],
    ['checkpoint.minMessagesBeforeInject', config.checkpoint.minMessagesBeforeInject, 0, COUNT_MAX, true],
    ['checkpoint.maxRawCapturesPerCheckpoint', config.checkpoint.maxRawCapturesPerCheckpoint, 1, COUNT_MAX, true],
    ['checkpoint.maxRawCaptureBytes', config.checkpoint.maxRawCaptureBytes, 1, SIZE_MAX, true],
    ...autoRanges,
    ['contextCompiler.modes.cheap', config.contextCompiler.modes.cheap, 1_000, 10_000_000, true],
    ['contextCompiler.modes.normal', config.contextCompiler.modes.normal, 1_000, 10_000_000, true],
    ['contextCompiler.modes.deep', config.contextCompiler.modes.deep, 1_000, 10_000_000, true],
    ['contextCompiler.recentTurnWindow', config.contextCompiler.recentTurnWindow, 0, COUNT_MAX, true],
    ['contextCompiler.logDetailsRetentionDays', config.contextCompiler.logDetailsRetentionDays, 0, 3_650, true],
  ];
}

function continuityRanges(config: PluginConfig): ConfigRange[] {
  return [
    ['contextCache.minTokensToCache', config.contextCache.minTokensToCache, 1, 10_000_000, true],
    ['contextCache.manifestMaxTokens', config.contextCache.manifestMaxTokens, 1, 10_000_000, true],
    ['contextCache.retentionDays', config.contextCache.retentionDays, 1, 3_650, true],
    ['workJournal.maxResumeEntries', config.workJournal.maxResumeEntries, 1, COUNT_MAX, true],
    ['workJournal.maxIntentChars', config.workJournal.maxIntentChars, 1, SIZE_MAX, true],
    ['workJournal.injectMaxTokens', config.workJournal.injectMaxTokens, 1, 10_000_000, true],
    ['autoDocs.maxChangelogEntriesPerSession', config.autoDocs.maxChangelogEntriesPerSession, 1, COUNT_MAX, true],
    ['autoDocs.maxEntryLength', config.autoDocs.maxEntryLength, 1, SIZE_MAX, true],
    ['selfModel.updateIntervalMs', config.selfModel.updateIntervalMs, 1_000, TIMER_MAX, true],
    ['selfModel.confidenceIncrementRate', config.selfModel.confidenceIncrementRate, 0, 1],
    ['selfModel.uncertaintyIncrementRate', config.selfModel.uncertaintyIncrementRate, 0, 1],
    ['selfModel.contradictionPenalty', config.selfModel.contradictionPenalty, 0, 1],
    ['selfModel.driftWarningThreshold', config.selfModel.driftWarningThreshold, 0, 1],
  ];
}

function livingStateRanges(config: PluginConfig): ConfigRange[] {
  return [
    ['beliefKnowledge.consolidationIntervalMs', config.beliefKnowledge.consolidationIntervalMs, 1_000, TIMER_MAX, true],
    ['beliefKnowledge.confidenceThreshold', config.beliefKnowledge.confidenceThreshold, 0, 1],
    ['beliefKnowledge.uncertaintyThreshold', config.beliefKnowledge.uncertaintyThreshold, 0, 1],
    ['beliefPromotion.minConfidence', config.beliefPromotion.minConfidence, 0, 1],
    ['beliefPromotion.minReinforcement', config.beliefPromotion.minReinforcement, 1, COUNT_MAX, true],
    ['beliefPromotion.minEvidenceRefs', config.beliefPromotion.minEvidenceRefs, 1, COUNT_MAX, true],
    ['beliefPromotion.minSessions', config.beliefPromotion.minSessions, 1, COUNT_MAX, true],
    ['beliefPromotion.maxPromotePerRun', config.beliefPromotion.maxPromotePerRun, 1, COUNT_MAX, true],
    ['livingState.maxAdvisoryBlockChars', config.livingState.maxAdvisoryBlockChars, 1, SIZE_MAX, true],
    ['livingState.scanLookbackMinutes', config.livingState.scanLookbackMinutes, 1, COUNT_MAX, true],
    ['livingState.maxScanPerType', config.livingState.maxScanPerType, 1, COUNT_MAX, true],
    ['livingState.updateIntervalMs', config.livingState.updateIntervalMs, 1_000, TIMER_MAX, true],
    ['reentry.maxChars', config.reentry.maxChars, 1, SIZE_MAX, true],
    ['reentry.minLayerChars', config.reentry.minLayerChars, 1, config.reentry.maxChars, true],
  ];
}

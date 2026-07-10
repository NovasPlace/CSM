import type { PluginConfig } from './types.js';

type ConfigOverrides = Record<string, unknown>;

export function mergePluginConfig(
  base: PluginConfig,
  overrides?: ConfigOverrides,
): PluginConfig {
  if (!overrides) return base;
  return mergeRecords(base, overrides) as unknown as PluginConfig;
}

function mergeRecords(base: object, overrides: ConfigOverrides): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const baseValue = merged[key];
    merged[key] = isRecord(baseValue) && isRecord(value)
      ? mergeRecords(baseValue, value)
      : value;
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Keeps the SQLite MVP on its supported core path instead of starting
 * PostgreSQL-only services that depend on tables SQLite does not create.
 */
export function normalizeProviderRuntimeConfig(config: PluginConfig): PluginConfig {
  if (config.databaseProvider !== 'sqlite') return config;

  return {
    ...config,
    workLedger: { ...config.workLedger, enabled: false },
    checkpoint: { ...config.checkpoint, enabled: false, auto: { ...config.checkpoint.auto, enabled: false } },
    contextCache: { ...config.contextCache, enabled: false },
    contextCompiler: { ...config.contextCompiler, enabled: false },
    contextRollover: { ...config.contextRollover, enabled: false },
    distiller: { ...config.distiller, enabled: false },
    workJournal: { ...config.workJournal, enabled: false, persistOnDispose: false },
    selfContinuity: {
      ...config.selfContinuity,
      enabled: false,
      deepContinuity: config.selfContinuity.deepContinuity
        ? { ...config.selfContinuity.deepContinuity, enabled: false }
        : undefined,
    },
    selfModel: { ...config.selfModel, enabled: false },
    beliefKnowledge: { ...config.beliefKnowledge, enabled: false },
    beliefPromotion: { ...config.beliefPromotion, enabled: false },
    livingState: { ...config.livingState, enabled: false, injectAdvisoryBlock: false },
    reentry: { ...config.reentry, enabled: false },
  };
}

import type { PluginConfig } from './types.js';
import type { RuntimePluginConfig } from './runtime-plugin-config.js';
import { validateDatabaseRuntimeConfig } from './database-runtime-config.js';
import { getEnvBoolean } from './config-env.js';
import { validateDatabaseTarget } from './config-provider.js';
import { allConfigRanges, type ConfigRange } from './config-validation-ranges.js';

export function validateConfig(config: RuntimePluginConfig): void {
  validateDatabaseTarget(config);
  validateEmbeddingDimensions(config.embeddingDimensions);
  if (config.databaseRuntime) validateDatabaseRuntimeConfig(config.databaseRuntime);
  validateProductionRequirement(config);
  validateRanges(allConfigRanges(config));
  if (config.contextPressureRecommend >= config.contextPressureDemand) {
    throw new Error('contextPressureRecommend must be less than contextPressureDemand');
  }
  if (config.extractor.confidenceThreshold > config.extractor.autoApproveThreshold) {
    throw new Error('extractor.confidenceThreshold must not exceed autoApproveThreshold');
  }
  validateCompilerModes(config);
}

function validateEmbeddingDimensions(dimensions: number | undefined): void {
  if (dimensions === undefined) return;
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('embeddingDimensions must be a positive integer');
  }
}

function validateProductionRequirement(config: PluginConfig): void {
  const requireExplicit = getEnvBoolean('CSM_REQUIRE_EXPLICIT_DATABASE_URL', false);
  if (requireExplicit && config.databaseProvider === 'postgres' && !process.env.CSM_DATABASE_URL) {
    throw new Error('CSM_DATABASE_URL is required in production mode');
  }
}

function validateRanges(ranges: readonly ConfigRange[]): void {
  for (const [name, value, min, max, integer] of ranges) {
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      const kind = integer ? 'integer ' : '';
      throw new Error(`${name} must be a finite ${kind}between ${min} and ${max}`);
    }
  }
}

function validateCompilerModes(config: PluginConfig): void {
  const { cheap, normal, deep } = config.contextCompiler.modes;
  if (cheap > normal || normal > deep) {
    throw new Error('contextCompiler modes must be ordered cheap <= normal <= deep');
  }
}

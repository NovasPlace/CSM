import type { PluginConfig } from './types.js';
import { baseDefaultsFromEnv } from './config-defaults-base.js';
import { continuityDefaultsFromEnv } from './config-defaults-continuity.js';
import { loadDotEnv } from './config-env.js';
import { validateConfig } from './config-validation.js';

loadDotEnv();

export const DEFAULT_CONFIG: PluginConfig = {
  ...baseDefaultsFromEnv(),
  ...continuityDefaultsFromEnv(),
};

export function validateAndReturnConfig(): PluginConfig {
  validateConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function validatePluginConfig(config: PluginConfig): PluginConfig {
  validateConfig(config);
  return config;
}

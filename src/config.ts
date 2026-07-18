import type { RuntimePluginConfig } from './runtime-plugin-config.js';
export type { RuntimePluginConfig } from './runtime-plugin-config.js';
import { baseDefaultsFromEnv } from './config-defaults-base.js';
import { continuityDefaultsFromEnv } from './config-defaults-continuity.js';
import { loadDotEnv } from './config-env.js';
import { validateConfig } from './config-validation.js';

loadDotEnv();

export const DEFAULT_CONFIG: RuntimePluginConfig = {
  ...baseDefaultsFromEnv(),
  ...continuityDefaultsFromEnv(),
};

export function validateAndReturnConfig(): RuntimePluginConfig {
  validateConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function validatePluginConfig(config: RuntimePluginConfig): RuntimePluginConfig {
  validateConfig(config);
  return config;
}

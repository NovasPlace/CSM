import type { RuntimePluginConfig } from './runtime-plugin-config.js';
export type { RuntimePluginConfig } from './runtime-plugin-config.js';
import { baseDefaultsFromEnv } from './config-defaults-base.js';
import { continuityDefaultsFromEnv } from './config-defaults-continuity.js';
import { loadDotEnv } from './config-env.js';
import { validateConfig } from './config-validation.js';

// Load the active project's environment. Packaged launchers provide any shared
// checkout/config directory explicitly through CSM_CONFIG_DIR.
loadDotEnv(process.cwd());
if (process.env.CSM_CONFIG_DIR) loadDotEnv(process.env.CSM_CONFIG_DIR);

export const DEFAULT_CONFIG: RuntimePluginConfig = {
  ...baseDefaultsFromEnv(),
  ...continuityDefaultsFromEnv(),
};

export function defaultConfigForDirectory(directory?: string): RuntimePluginConfig {
  if (directory) loadDotEnv(directory);
  const sharedConfigDirectories = [
    process.env.CSM_CONFIG_DIR,
    process.env.PLUGIN_DATA,
    process.env.CLAUDE_PLUGIN_DATA,
  ].filter((value): value is string => Boolean(value?.trim()));
  sharedConfigDirectories.forEach((configDirectory) => loadDotEnv(configDirectory));
  return {
    ...baseDefaultsFromEnv(),
    ...continuityDefaultsFromEnv(),
  };
}

export function validateAndReturnConfig(): RuntimePluginConfig {
  validateConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function validatePluginConfig(config: RuntimePluginConfig): RuntimePluginConfig {
  validateConfig(config);
  return config;
}

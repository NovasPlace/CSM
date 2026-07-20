import type { RuntimePluginConfig } from './runtime-plugin-config.js';
export type { RuntimePluginConfig } from './runtime-plugin-config.js';
import { baseDefaultsFromEnv } from './config-defaults-base.js';
import { continuityDefaultsFromEnv } from './config-defaults-continuity.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadDotEnv } from './config-env.js';
import { validateConfig } from './config-validation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = resolve(__dirname, '..');

// Load environment from process.cwd() (project specific overrides) first,
// then fallback to pluginRoot's .env for default configuration.
loadDotEnv(process.cwd());
loadDotEnv(pluginRoot);

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

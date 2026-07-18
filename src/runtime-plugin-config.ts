import type { PluginConfig } from './types.js';

export type RuntimePluginConfig = PluginConfig & {
  embeddingDimensions?: number;
};

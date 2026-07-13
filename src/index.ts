// Cross-Session Memory Plugin for Opencode
// Version 2.0 - Modularized architecture
// AUTO-EXPORTED from module imports

// Import and re-export from module exports
import { registerHooks } from './hooks-registration.js';

export default registerHooks;

export const CSMPlugin = registerHooks;

export type { PluginInput, PluginOptions, Hooks } from '@opencode-ai/plugin';
export type { DatabasePool, Memory, MemoryType, ToolCallRecord, CompactionResult, BucketBreakdown } from './types.js';

// Cross-Session Memory Plugin for Opencode
// Version 2.0 - Modularized architecture
// AUTO-EXPORTED from module imports

// Import and re-export from module exports
import { registerHooks } from './hooks-registration.js';

// v1 plugin format: default export object with server() and id
export default {
  id: 'cross-session-memory',
  server: registerHooks,
};

// Re-export types
export type { PluginInput, PluginOptions, Hooks } from '@opencode-ai/plugin';
export type { DatabasePool, Memory, MemoryType, ToolCallRecord, CompactionResult, BucketBreakdown } from './types.js';

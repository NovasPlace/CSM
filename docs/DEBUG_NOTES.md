# DEBUG_NOTES.md

## Known Failure Points

### 1. PostgreSQL Connection Failures
- **Symptom**: `ECONNREFUSED` or `ENOTFOUND` on plugin load
- **Cause**: PostgreSQL not running, wrong host/port, auth failure
- **Recovery**: 
  - Verify psql connection string works
  - Check `docker ps` if using container
  - Verify `pgvector` extension: `CREATE EXTENSION IF NOT EXISTS vector;`
- **Config**: `database.url` in OpenCode config or `DATABASE_URL` env

### 2. Migration Failures
- **Symptom**: `relation "sessions" does not exist` or column mismatch
- **Cause**: Schema drift, partial migration, manual DB edits
- **Recovery**: 
  - `DROP TABLE memories CASCADE;` then restart plugin (auto-migrates)
  - Or run migrations manually from `src/database.ts:initializeSchema()`
- **Prevention**: Never edit schema manually; ALTER TABLE constraints in `initializeSchema`

### 3. Embedding Generation Errors
- **Symptom**: `memory_search` returns empty or throws
- **Cause**: Embedding model unavailable, dimension mismatch (expects 1536), API quota
- **Recovery**: 
  - Check `MEMORY_EMBEDDING_MODEL` env (default: `text-embedding-3-small`)
  - Verify `embedding` column is `VECTOR(1536)`
  - Disable semantic search: `semanticSearch: false` in config

### 4. Context Compaction Data Loss
- **Symptom**: Important tool output missing from context
- **Cause**: Compactor aggressively summarizes; risk labels misclassified
- **Recovery**: 
  - Increase `contextTokenBudget` in config
  - Check `ContextCompactor` risk classification logic
  - Disable: `compactContext: false`

### 5. Hybrid Search Empty Results
- **Symptom**: `hybridSearch()` returns empty despite matching memories
- **Cause**: 
  - `$2` parameter conflict (LIMIT vs JSONB cast) — fixed Phase 9
  - `metadata.extracted_concepts` not in WHERE clause — fixed Phase 9
  - Entity boost returning 0 because SQL query never matches
- **Recovery**: 
  - Check `entityMatchBoost()` SQL in `hybrid-search.ts`
  - Verify `$1`, `$2`, `$3` parameter indexing is correct
  - Ensure `embedding` column populated in `memories` table
- **Prevention**: Test entityMatchBoost independently; never reuse `$N` params

### 6. Sessions Table Missing
- **Symptom**: `relation "sessions" does not exist` on database connect
- **Cause**: `initializeSchema()` assumed sessions table pre-existed; fresh DB doesn't have it
- **Recovery**: Schema now creates sessions table with `id, project_id, directory, title, created_at, updated_at`
- **Prevention**: `CREATE TABLE IF NOT EXISTS sessions` + ALTER TABLE for missing columns

### 7. Check Constraint Violations
- **Symptom**: `new row for relation "memories" violates check constraint "memories_memory_type_check"`
- **Cause**: New memory types (concept, code, config, error) not in DB constraint
- **Recovery**: ALTER TABLE in `initializeSchema()` now drops and recreates constraints with full type list
- **Prevention**: Add new types to BOTH `CREATE TABLE` and `ALTER TABLE ... DROP + ADD CONSTRAINT`

### 8. Compaction Quality Below Threshold
- **Symptom**: Compaction rejected with `quality_score < 0.6`
- **Cause**: Critical entities, decisions, or errors dropped during compaction
- **Recovery**:
  - Check `CompactionQualityMetrics.warningErrorRetention` — should be > 0.8
  - Reduce compaction aggressiveness (increase budget cap)
  - Review preserved signals in `ContextCompactor`
- **Prevention**: Monitor `lastQuality` on `ContextCompactor`; tune threshold per project

### 9. Doc-Analyzer Spam
- **Symptom**: SYSTEM_MAP.md fills with stub entries (`src/a.ts: Exports: none, Imports: , Type: source`)
- **Cause**: No dedup, no stub filtering, no file-existence check in `applyDocUpdate()`
- **Recovery**: 
  - Delete spam entries manually
  - Ensure `isStubContent()` and dedup guards are active in `doc-analyzer.ts`
- **Prevention**: `isStubContent()` filters files with no exports/imports; `applyDocUpdate()` checks for existing entries

### 10. Defender ClickFix Heuristic
- **Symptom**: Windows Security flags a PowerShell command as a severe threat
- **Cause**: The command downloads an archive into a temp folder and expands it before inspection
- **Recovery**:
  - Do not rerun the download-and-expand path
  - Prefer `.\scripts\safe-review-copy.ps1` or `.\scripts\safe-review-copy.ps1 -Archive`
  - Keep the review copy local so Defender does not see a download-to-execute pattern
- **Prevention**: Avoid `Invoke-WebRequest ... | Expand-Archive` review flows for GitHub repos
- **Note**: In this repo, the alert was treated as a false positive after the source tree and a fresh ZIP scan came back clean

---

## Error Patterns

| Error | Module | Frequency | Fix |
|-------|--------|-----------|-----|
| `password authentication failed` | database.ts | High | Check `.env` / config |
| `vector dimension mismatch` | embeddings.ts | Medium | Recreate table with correct dim |
| `relation "sessions" does not exist` | database.ts | Medium | Run `initializeSchema()` |
| `check constraint violation` | database.ts | Medium | ALTER TABLE to add new type values |
| `column "embedding" does not exist` | database.ts | Low | ALTER TABLE to add embedding column |
| `no session found` | memory-manager.ts | Medium | Ensure session initialized |
| `quality_score below threshold` | compaction-quality.ts | Low | Check entity/error retention |

---

**C:/Users/Donovan/Desktop/cross-session-memory/src/context-injection-logger.ts** (2026-07-13)
Detected: Error:
Context: import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import type { BuiltContextInjection, ContextInjectionItem } from './context-injection-contract.js';

export interface ContextInjectionLoggerConfig {
  enabled: boolean;
  environment: 'production' | 'fixture' | ...

**C:/Users/Donovan/Desktop/cross-session-memory/src/context-injection-logger.ts** (2026-07-13)
Detected: Error:
Context: import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import type { BuiltContextInjection, ContextInjectionItem } from './context-injection-contract.js';

export interface ContextInjectionLoggerConfig {
  enabled: boolean;
  environment: 'production' | 'fixture' | ...

**C:/Users/Donovan/Desktop/cross-session-memory/src/context-injection-logger.ts** (2026-07-13)
Detected: Error:
Context: import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import type { BuiltContextInjection, ContextInjectionItem } from './context-injection-contract.js';

export interface ContextInjectionLoggerConfig {
  enabled: boolean;
  environment: 'production' | 'fixture' | ...

**C:/Users/Donovan/Desktop/cross-session-memory/src/context-injection-logger.ts** (2026-07-13)
Detected: Error:
Context: import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import type { BuiltContextInjection, ContextInjectionItem } from './context-injection-contract.js';

export interface ContextInjectionLoggerConfig {
  enabled: boolean;
  environment: 'production' | 'fixture' | ...

**C:/Users/Donovan/Desktop/cross-session-memory/src/context-injection-logger.ts** (2026-07-13)
Detected: Error:
Context: import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import type { BuiltContextInjection, ContextInjectionItem } from './context-injection-contract.js';

export interface ContextInjectionLoggerConfig {
  enabled: boolean;
  environment: 'production' | 'fixture' | ...

**C:/Users/Donovan/Desktop/cross-session-memory/src/context-injection-audit.ts** (2026-07-13)
Detected: failed:
Context: import type { DatabasePool } from './types.js';

export interface InjectionAuditReport {
  summary: {
    totalEvents: number;
    totalItems: number;
    byKind: Record<string, number>;
    byStatus: Record<string, number>;
    byEnvironment: Record<string, number>;
    byTrimLevel: Record<string, ...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/system-transform.ts** (2026-07-13)
Detected: Error:, timeout
Context: import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
...

**src/hooks/messages-transform.ts** (2026-07-14)
Detected: failed:
Context: import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logg...

**src/hooks/messages-transform.ts** (2026-07-14)
Detected: failed:
Context: import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logg...

**src/hooks/messages-transform.ts** (2026-07-14)
Detected: failed:
Context: import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logg...

**src/hooks/messages-transform.ts** (2026-07-14)
Detected: failed:
Context: import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logg...

**src/hooks/messages-transform.ts** (2026-07-14)
Detected: failed:
Context: import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logg...

**src/hooks/messages-transform.ts** (2026-07-14)
Detected: failed:
Context: import type { PluginContext } from '../plugin-context.js';
import type { ToolCallRecord } from '../types.js';
import { extractTextParts, rememberUserTurn } from './reentry-source-only.js';
import { persistCompactionTelemetry } from '../compaction-metric-writer.js';
import { getLogger } from '../logg...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/context-compiler.ts** (2026-07-15)
Detected: ECONNREFUSED, ENOTFOUND, ETIMEDOUT
Context: /**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → com...

**src/embeddings.ts** (2026-07-15)
Detected: Error:
Context: // Embedding generation for semantic search
// Supports OpenAI API, Ollama local API, or hash-based fallback (dev/test)

import { PluginConfig } from './types.js';
import { getLogger } from './logger.js';

export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1536;
...

**src/embeddings.ts** (2026-07-15)
Detected: Error:
Context: // Embedding generation for semantic search
// Supports OpenAI API, Ollama local API, or hash-based fallback (dev/test)

import { PluginConfig } from './types.js';
import { getLogger } from './logger.js';

export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1536;
...

**src/memory-manager.ts** (2026-07-15)
Detected: Error:, failed:, race condition
Context: // Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from...

**src/memory-manager.ts** (2026-07-15)
Detected: Error:, failed:, race condition
Context: // Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from...

**src/memory-manager.ts** (2026-07-15)
Detected: Error:, failed:, race condition
Context: // Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from...

**src/embedding-backfill.ts** (2026-07-15)
Detected: failed:, timeout
Context: import type { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { getLogger } from './logger.js';
import { nowFn } from './db/query-dialect.js';

export interface EmbeddingBackfillConfig {
  /** Memories per batch (default 50) */
  batchSize?: numbe...

**src/embedding-backfill.ts** (2026-07-15)
Detected: failed:, timeout
Context: import type { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { getLogger } from './logger.js';
import { nowFn } from './db/query-dialect.js';

export interface EmbeddingBackfillConfig {
  /** Memories per batch (default 50) */
  batchSize?: numbe...

**src/embeddings.ts** (2026-07-15)
Detected: Error:
Context: // Embedding generation for semantic search
// Supports OpenAI API, Ollama local API, or hash-based fallback (dev/test)

import { PluginConfig } from './types.js';
import { getLogger } from './logger.js';

export const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS) || 1536;
...

**src/database.ts** (2026-07-15)
Detected: Error:
Context: import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseStartupState,
  PluginConfig,
} from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { getLogger } from './logger.js';
import type { Quer...

**src/database.ts** (2026-07-15)
Detected: Error:
Context: import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseStartupState,
  PluginConfig,
} from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { getLogger } from './logger.js';
import type { Quer...

**src/database.ts** (2026-07-15)
Detected: Error:
Context: import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseStartupState,
  PluginConfig,
} from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { ensureEmbeddingColumnContract } from './schema/memo...

**src/database.ts** (2026-07-15)
Detected: Error:
Context: import type {
  DatabaseDiagnostics,
  DatabasePool,
  DatabaseStartupState,
  PluginConfig,
} from './types.js';
import { createDatabasePool } from './db/database-pool.js';
import { initializeAllSchemas } from './schema/index.js';
import { ensureEmbeddingColumnContract } from './schema/memo...

**src/hooks/tool-hooks.ts** (2026-07-16)
Detected: Error:
Context: import {
  memorySaveTool, memorySearchTool, memoryListTool, memoryDeleteTool,
  memoryContextTool, memoryLessonTool, memoryTranscriptTool,
  memoryDistillTool, memoryDistilledViewTool, memoryCompactTool,
  runtimeStatusTool, compactionAuditTool, recallQualityReportTool, memoryRelatedTool, conti...

**src/hooks/tool-hooks.ts** (2026-07-16)
Detected: Error:
Context: import {
  memorySaveTool, memorySearchTool, memoryListTool, memoryDeleteTool,
  memoryContextTool, memoryLessonTool, memoryTranscriptTool,
  memoryDistillTool, memoryDistilledViewTool, memoryCompactTool,
  runtimeStatusTool, compactionAuditTool, recallQualityReportTool, memoryRelatedTool, conti...

**src/re-entry-protocol.ts** (2026-07-16)
Detected: TypeError
Context: import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type...

**src/re-entry-protocol.ts** (2026-07-16)
Detected: TypeError
Context: import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type...

**src/memory-extractor.ts** (2026-07-16)
Detected: Error:, failure:
Context: // Memory Extractor - Auto-extract salient facts from conversation turns
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { MemoryManager } from './memory-manager.js';
import { getLogger } from '...

**test/memory-extractor-dedup.test.ts** (2026-07-16)
Detected: Error:
Context: import { strict as assert } from 'assert';
import { test } from 'node:test';
import { MemoryExtractor } from '../src/memory-extractor.js';
import type { Memory, MemoryManager } from '../src/memory-manager.js';
import type { Database } from '../src/database.js';
import type { ExtractorConfig } f...

**src/re-entry-protocol.ts** (2026-07-16)
Detected: TypeError
Context: import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type...

## Recovery Procedures

### Full Reset (Nuclear)
```bash
# Drop all data, start fresh
psql "$DATABASE_URL" -c "DROP TABLE IF EXISTS memories, memory_chunks, sessions, memory_events, session_contexts CASCADE;"
# Restart plugin — auto-migrates
```

### Soft Reset (Keep Memories, Fix Schema)
```bash
# Re-run constraint updates
psql "$DATABASE_URL" -c "ALTER TABLE memories DROP CONSTRAINT IF EXISTS memories_memory_type_check;"
psql "$DATABASE_URL" -c "ALTER TABLE memories ADD CONSTRAINT memories_memory_type_check CHECK (memory_type IN ('conversation','workspace','repo','preference','lesson','episodic','procedural','concept','code','config','error'));"
```

### Verify DB Health
```sql
-- Count memories by type
SELECT memory_type, COUNT(*) FROM memories GROUP BY memory_type;

-- Check embedding coverage
SELECT COUNT(*) as total, 
       COUNT(embedding) as with_embedding,
       COUNT(*) - COUNT(embedding) as missing
FROM memories;

-- Check sessions
SELECT id, project_id, directory, title FROM sessions LIMIT 10;

-- Check vector extension
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

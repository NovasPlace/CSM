# AGENT_MEMORY.md

> Materialized memory map. Updated by auto-docs hook.
> This file is a quick-reference for the agent's own accumulated knowledge.

## Core Architecture
- **Plugin entry**: `src/index.ts` → `CrossSessionMemoryPlugin` (OpenCode `Plugin` interface)
- **Database layer**: `src/database.ts` → PostgreSQL + pgvector; schema auto-creates sessions/memories/memory_chunks/memory_events/session_contexts
- **Memory manager**: `src/memory-manager.ts` → CRUD + search (save, load, search_memories, create_session, checkpoint)
- **Embeddings**: `src/embeddings.ts` → Ollama or OpenAI; VECTOR(1536); stored in both `memories.embedding` and `memory_chunks`
- **Context compiler**: `src/context-compiler.ts` → compacts context into budget; risk labels; distilled summaries
- **Context compactor**: `src/context-compactor.ts` → compresses tool outputs; now tracks `CompactionQualityMetrics`
- **Hybrid search**: `src/hybrid-search.ts` → vector + text + entity RRF; weights: v=0.35, t=0.25, e=0.35, r=0.05
- **Compaction quality**: `src/compaction-quality.ts` → entity/decision/error retention, embedding drift, quality_score (threshold 0.6)

## Hooks
- **tool-execute.after**: fires `auto-docs.ts:queueDocUpdate()` on file writes; flushes at session end
- **auto-docs.ts**: queues, deduplicates, groups doc updates; flushes to CHANGELOG_LIVE.md
- **doc-analyzer.ts**: generates SYSTEM_MAP, DECISIONS, DEBUG_NOTES entries; now with dedup + stub filtering

## TUI Layer
- **src/tui.ts**: Solid.js Map + Compaction dashboard; renamed from .tsx; graceful failure if Solid unavailable

## Session Flow
1. Plugin loads → DB connects → schema auto-creates/migrates
2. Session starts → `createSession()` → prime memories from previous sessions
3. During session: memories saved, auto-docs queued, context compacted
4. Session end: `checkpoint()` → flush auto-docs → dispose

## Key Constraints
- **Memory types**: conversation, workspace, repo, preference, lesson, episodic, procedural, concept, code, config, error
- **Emotions**: neutral, frustration, frustrated, success, curiosity, concern
- **Quality score formula**: entity_retention×0.35 + decision_retention×0.25 + error_retention×0.25 + similarity×0.15
- **Quality threshold**: < 0.6 → compaction rejected as unsafe

## Agent Protocols
**IMPLEMENTATION_AGENT_PROTOCOL.md** (2026-06-27)
# Implementation Agent Protocol v2

**Mayday-protected ruleset for code execution, verification, and simplified implementation discipline.**

---

**IMPLEMENTATION_AGENT_PROTOCOL.md** (2026-07-11)
# Implementation Agent Protocol v2

**Mayday-protected ruleset for code execution, verification, and simplified implementation discipline.**

---

**IMPLEMENTATION_AGENT_PROTOCOL.md** (2026-07-11)
# Implementation Agent Protocol v2

**Mayday-protected ruleset for code execution, verification, and simplified implementation discipline.**

---

**IMPLEMENTATION_AGENT_PROTOCOL.md** (2026-07-11)
# Implementation Agent Protocol v2

**Mayday-protected ruleset for code execution, verification, and simplified implementation discipline.**

---

## 1. Identity + Role

You are an implementation agent. You execute architectural decisions made by the architect. You do not originate architecture — you realize it.

* You write code. The architect designs systems.
* When you encounter an architectural ambiguity, you flag it and halt. You do not resolve it silently.
* You do not add features, models, handlers, or domains not present in the spec. Flag additions as comments. Never implement them uninstructed.
* Your output is always reviewable. Propose diffs. Do not apply destructive changes without confirmation.

---

## 2. Persistence Layer

* **PostgreSQL exclusively.** SQLite is forbidden in all contexts.
* `AUTOINCREMENT` is SQLite syntax. Never use it. Use `SERIAL`, `UUID DEFAULT gen_random_uuid()`, or `BIGINT GENERATED ALWAYS AS IDENTITY`.
* All SQL must be valid PostgreSQL 14+.
* All...

## 1. Identity + Role

You are an implementation agent. You execute architectural decisions made by the architect. You do not originate architecture — you realize it.

* You write code. The architect designs systems.
* When you encounter an architectural ambiguity, you flag it and halt. You do not resolve it silently.
* You do not add features, models, handlers, or domains not present in the spec. Flag additions as comments. Never implement them uninstructed.
* Your output is always reviewable. Propose diffs. Do not apply destructive changes without confirmation.

---

## 2. Persistence Layer

* **PostgreSQL exclusively.** SQLite is forbidden in all contexts.
* `AUTOINCREMENT` is SQLite syntax. Never use it. Use `SERIAL`, `UUID DEFAULT gen_random_uuid()`, or `BIGINT GENERATED ALWAYS AS IDENTITY`.
* All SQL must be valid PostgreSQL 14+.
* All...

## 1. Identity + Role

You are an implementation agent. You execute architectural decisions made by the architect. You do not originate architecture — you realize it.

* You write code. The architect designs systems.
* When you encounter an architectural ambiguity, you flag it and halt. You do not resolve it silently.
* You do not add features, models, handlers, or domains not present in the spec. Flag additions as comments. Never implement them uninstructed.
* Your output is always reviewable. Propose diffs. Do not apply destructive changes without confirmation.

---

## 2. Persistence Layer

* **PostgreSQL exclusively.** SQLite is forbidden in all contexts.
* `AUTOINCREMENT` is SQLite syntax. Never use it. Use `SERIAL`, `UUID DEFAULT gen_random_uuid()`, or `BIGINT GENERATED ALWAYS AS IDENTITY`.
* All SQL must be valid PostgreSQL 14+.
* All...

## 1. Identity + Role

You are an implementation agent. You execute architectural decisions made by the architect. You do not originate architecture — you realize it.

* You write code. The architect designs systems.
* When you encounter an architectural ambiguity, you flag it and halt. You do not resolve it silently.
* You do not add features, models, handlers, or domains not present in the spec. Flag additions as comments. Never implement them uninstructed.
* Your output is always reviewable. Propose diffs. Do not apply destructive changes without confirmation.

---

## 2. Persistence Layer

* **PostgreSQL exclusively.** SQLite is forbidden in all contexts.
* `AUTOINCREMENT` is SQLite syntax. Never use it. Use `SERIAL`, `UUID DEFAULT gen_random_uuid()`, or `BIGINT GENERATED ALWAYS AS IDENTITY`.
* All SQL must be valid PostgreSQL 14+.
* All...

## Lessons Learned
**C:/Users/Donovan/Desktop/cross-session-memory/src/reentry-layers-state.ts** (2026-07-13)
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefEntry, SelfModelCapability } from './types.js';
import type { ReEntryLayerText } from './reentry-layers-foundation.js';
import type { ContextInjectionItem } from './context-injection-contract.js';

export async function buildCapabilitie...

**C:/Users/Donovan/Desktop/cross-session-memory/src/reentry-contract.ts** (2026-07-13)
import type { ContextInjectionItem } from './context-injection-contract.js';

export { BUILDER_VERSION, computeConfigHash, validateBuiltContextInjection };
export type {
  BuiltContextInjection,
  ContextInjectionItem,
  ContextInjectionLayerSummary,
  InjectionKind,
  ItemDisposition,
  ItemSourceKind,
  ProvenanceGranularity,
  SelectionReasonCode,
} from './context-injection-contract.js';

export const REENTRY_HEADER = `## Agent Re-entry Context
Source: CSM continuity runtime.
Purpose: hydrat...

**C:/Users/Donovan/Desktop/cross-session-memory/test/context-injection-contract.test.ts** (2026-07-13)
import assert from 'node:assert/strict';
import { it, describe, before, after, beforeEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import {
  BUILDER_VERSION,
  computeConfigHash,
  validateBuiltContextInjection,
  type BuiltContextInjection,
  type ContextInjectionItem,
} from '../src/context-injection-contract.js';
import { DEFAULT_REENTRY_CONFIG } from '../src/...

**C:/Users/Donovan/Desktop/cross-session-memory/test/reentry-telemetry-integration.test.ts** (2026-07-13)
import assert from 'node:assert/strict';
import { it, describe, before, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { MemoryManager } from '../src/memory-manager.js';
import { SelfModelUpdater } from '../src/self-model-updater.js';
import { BeliefKnowledgeConsoli...

**C:/Users/Donovan/Desktop/cross-session-memory/test/reentry-telemetry-integration.test.ts** (2026-07-13)
import assert from 'node:assert/strict';
import { it, describe, before, beforeEach, afterEach } from 'node:test';
import { mkdirSync, rmSync } from 'node:fs';
import { Database } from '../src/database.js';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import { ContextInjectionLogger } from '../src/context-injection-logger.js';
import { MemoryManager } from '../src/memory-manager.js';
import { SelfModelUpdater } from '../src/self-model-updater.js';
import { BeliefKnowledgeConsoli...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/hooks/system-transform.ts** (2026-07-13)
import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stit...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/context-compiler.ts** (2026-07-15)
/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { Context...

**src/belief-promotion.ts** (2026-07-15)
import type { DatabasePool, MemoryType, BeliefPromotionConfig } from './types.js';
import { CAPABILITY_PROVENANCE_TAG, canonicalCapabilityKey } from './types.js';
import { dialectFromPool, jsonExtractText, nowFn, type QueryDialect } from './db/query-dialect.js';
import { getLogger } from './logger.js';
import { BELIEF_CANDIDATE_TYPES, type BeliefCandidateType } from './candidate-schema.js';
import type { MemoryManager } from './memory-manager.js';

export interface PromotionConfig {
  dr...

**src/memory-manager.ts** (2026-07-15)
// Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from './memory-graph.js';
import { hybridSearch } from './hybrid-search.js';
import { pruneMemories } from './prune-scorer.js';
import { Redactor } from './redactor.js';
import { DEFAULT_PRUNE_CONFIG ...

**src/memory-manager.ts** (2026-07-15)
// Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from './memory-graph.js';
import { hybridSearch } from './hybrid-search.js';
import { pruneMemories } from './prune-scorer.js';
import { Redactor } from './redactor.js';
import { DEFAULT_PRUNE_CONFIG ...

**src/memory-manager.ts** (2026-07-15)
// Memory Manager - CRUD operations with dual-write pattern
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { extractConcepts } from './concept-extractor.js';
import { buildLinksForMemory } from './memory-graph.js';
import { hybridSearch } from './hybrid-search.js';
import { pruneMemories } from './prune-scorer.js';
import { Redactor } from './redactor.js';
import { DEFAULT_PRUNE_CONFIG ...

**src/context-recall.ts** (2026-07-15)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/context-recall.ts** (2026-07-15)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/context-recall.ts** (2026-07-15)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/wiki-note-renderer.ts** (2026-07-15)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink, entityFilename } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
...

**src/wiki-export.ts** (2026-07-15)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export-tool.ts** (2026-07-16)
import { tool } from '@opencode-ai/plugin/tool';
import type { Database } from './database.js';
import { exportWiki } from './wiki-export.js';

export function wikiExportTool(database: Database) {
  return tool({
    description:
      'Export CSM memories to an Obsidian-style wiki with [[wikilinks]], frontmatter, and entity index. ' +
      'Curated mode (default) exports lessons, decisions, promoted knowledge, and high-importance memories. ' +
      'Full mode exports everything to a separate ...

**src/hooks/tool-hooks.ts** (2026-07-16)
import {
  memorySaveTool, memorySearchTool, memoryListTool, memoryDeleteTool,
  memoryContextTool, memoryLessonTool, memoryTranscriptTool,
  memoryDistillTool, memoryDistilledViewTool, memoryCompactTool,
  runtimeStatusTool, compactionAuditTool, recallQualityReportTool, memoryRelatedTool, continuityReportTool, reentryPreviewTool,
} from '../tools.js';
import { memoryBackfillEmbeddingsTool, memoryDedupDetectTool, memoryMergeDuplicatesTool, memoryCandidateGenerateTool, memoryCandidateReport...

**src/hooks/tool-hooks.ts** (2026-07-16)
import {
  memorySaveTool, memorySearchTool, memoryListTool, memoryDeleteTool,
  memoryContextTool, memoryLessonTool, memoryTranscriptTool,
  memoryDistillTool, memoryDistilledViewTool, memoryCompactTool,
  runtimeStatusTool, compactionAuditTool, recallQualityReportTool, memoryRelatedTool, continuityReportTool, reentryPreviewTool,
} from '../tools.js';
import { memoryBackfillEmbeddingsTool, memoryDedupDetectTool, memoryMergeDuplicatesTool, memoryCandidateGenerateTool, memoryCandidateReport...

**src/tool-names.ts** (2026-07-16)
/**
 * Central list of all CSM tool names.
 * Extracted to break circular dependency: tools.ts → tool-hooks.ts → tools.ts
 */
export const CSM_TOOL_NAMES = [
   'csm_memory_save',
   'csm_memory_search',
   'csm_memory_list',
   'csm_memory_delete',
   'csm_memory_context',
   'csm_memory_lesson',
   'csm_memory_transcript',
   'csm_memory_distill',
   'csm_memory_distilled_view',
   'csm_memory_compact',
   'csm_memory_backfill_embeddings',
   'csm_memory_dedup_detect',
   'csm...

**src/wiki-note-renderer.ts** (2026-07-16)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink, entityFilename } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**test/wiki-export.test.ts** (2026-07-16)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrontmatter } from '../dist/wiki-yaml-frontmatter.js';
import { slugify, entityFilename, memoryFilename, memoryWikilink } from '../dist/wiki-slug.js';
import {
  smartTitle,
  renderMemoryNote,
  renderEntityNote,
  renderIndexPage,
  renderLogEntry,
  categoryForMemory,
  type ExportedLink,
  type ExportedEntity,
} from '../dist/wiki-note-renderer.js';

// ==========================================...

**test/wiki-export.test.ts** (2026-07-16)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrontmatter } from '../dist/wiki-yaml-frontmatter.js';
import { slugify, entityFilename, memoryFilename, memoryWikilink } from '../dist/wiki-slug.js';
import {
  smartTitle,
  renderMemoryNote,
  renderEntityNote,
  renderIndexPage,
  renderLogEntry,
  categoryForMemory,
  type ExportedLink,
  type ExportedEntity,
} from '../dist/wiki-note-renderer.js';

// ==========================================...

**test/wiki-export.test.ts** (2026-07-16)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderFrontmatter } from '../dist/wiki-yaml-frontmatter.js';
import { slugify, entityFilename, memoryFilename, memoryWikilink } from '../dist/wiki-slug.js';
import {
  smartTitle,
  renderMemoryNote,
  renderEntityNote,
  renderIndexPage,
  renderLogEntry,
  categoryForMemory,
  type ExportedLink,
  type ExportedEntity,
} from '../dist/wiki-note-renderer.js';

// ==========================================...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-note-renderer.ts** (2026-07-16)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
  strength: numb...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-note-renderer.ts** (2026-07-16)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
  strength: numb...

**src/wiki-note-renderer.ts** (2026-07-16)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
  strength: numb...

**src/wiki-note-renderer.ts** (2026-07-16)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink, entityFilename } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
...

**src/wiki-note-renderer.ts** (2026-07-16)
/**
 * Pure renderers for Obsidian wiki export.
 *
 * All functions are pure: they take data and return strings. No file I/O.
 * This makes them easy to unit-test against fixtures.
 */

import type { Memory, MemoryType } from './types.js';
import { renderFrontmatter } from './wiki-yaml-frontmatter.js';
import { memoryFilename, memoryWikilink, entityFilename } from './wiki-slug.js';

// --- Types used by renderers ---

export interface ExportedLink {
  targetMemoryId: number;
  linkType: string;
...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/wiki-export.ts** (2026-07-16)
/**
 * CSM → Obsidian wiki export engine.
 *
 * Core export pipeline:
 *  1. Single read transaction for consistent snapshot
 *  2. Memory selection (curated / full mode)
 *  3. One-hop linked inclusion (not recursive)
 *  4. Entity index from extracted concepts of included memories
 *  5. Note rendering via pure renderers
 *  6. Manifest-based incremental detection
 *  7. Atomic writes (temp + rename)
 *  8. Pruning of manifest-owned files no longer eligible
 */

import { createHash } from 'nod...

**src/context-recall.ts** (2026-07-16)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/context-recall.ts** (2026-07-16)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/context-recall.ts** (2026-07-16)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/context-recall.ts** (2026-07-16)
// ContextRecallDaemon - Rebuilds context brief every 90 seconds
// Inspired by Agent Atlas context_recall.py
// Builds compressed <=50 line context brief from three tiers:
// 1. Episodic: Recent file changes, session events (last 6 hours)
// 2. Procedural: Top lessons primed to current work
// 3. Semantic: Current project states

import { Database } from './database.js';
import { Memory, ContextBrief, ToolCallGroup } from './types.js';
import { recordRecallBatch } from './recall-teleme...

**src/bridge-ops.ts** (2026-07-16)
import type { Database } from './database.js';
import type { ContextCompactor } from './context-compactor.js';
import type { ContextRecallDaemon } from './context-recall.js';
import type { MemoryManager } from './memory-manager.js';
import type { PrimingEngine } from './priming-engine.js';
import { rankMemoriesByProvenance } from './bridge-provenance.js';
import type { BackfillEmbeddingsResult, ContextBrief, Memory, MemorySaveOptions, MemorySearchOptions, PruneReport } from './types.js';
...

**src/re-entry-protocol.ts** (2026-07-16)
import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { AgentWorkJournal } from './agent-work-journal.js';
import {
  type BuiltContextInjection,
} from './context-injection-contract.js';
import { buildReentryProvenance } from './reentry-injection-prove...

**src/re-entry-protocol.ts** (2026-07-16)
import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { AgentWorkJournal } from './agent-work-journal.js';
import {
  type BuiltContextInjection,
} from './context-injection-contract.js';
import { buildReentryProvenance } from './reentry-injection-prove...

**src/candidate-generator.ts** (2026-07-16)
import type { Database } from './database.js';
import { dialectFromPool, ageDaysExpr, jsonParam, isUniqueViolation } from './db/query-dialect.js';
import type { QueryDialect } from './db/query-dialect.js';

export type CandidateType =
  | 'prune'
  | 'promote_to_lesson'
  | 'merge'
  | 'stale_preference'
  | 'refresh_summary';

export type CandidateStatus = 'pending' | 'reviewed' | 'dismissed' | 'applied';

export const ALL_CANDIDATE_TYPES: CandidateType[] = [
  'prune',
  'promot...

**src/memory-extractor.ts** (2026-07-16)
// Memory Extractor - Auto-extract salient facts from conversation turns
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { MemoryManager } from './memory-manager.js';
import { getLogger } from './logger.js';
import { nowFn, jsonExtractText } from './db/query-dialect.js';
import {
  MemoryType,
  MemoryEmotion,
  MemoryCandidate,
  MemoryCandidateStatus,
  MemoryApproval,
  ExtractorC...

**src/candidate-generator.ts** (2026-07-16)
import type { Database } from './database.js';
import { dialectFromPool, ageDaysExpr, jsonParam, isUniqueViolation } from './db/query-dialect.js';
import type { QueryDialect } from './db/query-dialect.js';

export type CandidateType =
  | 'prune'
  | 'promote_to_lesson'
  | 'merge'
  | 'stale_preference'
  | 'refresh_summary';

export type CandidateStatus = 'pending' | 'reviewed' | 'dismissed' | 'applied';

export const ALL_CANDIDATE_TYPES: CandidateType[] = [
  'prune',
  'promot...

**test/memory-extractor-dedup.test.ts** (2026-07-16)
import { strict as assert } from 'assert';
import { test } from 'node:test';
import { MemoryExtractor } from '../src/memory-extractor.js';
import type { Memory, MemoryManager } from '../src/memory-manager.js';
import type { Database } from '../src/database.js';
import type { ExtractorConfig } from '../src/types.js';

const testConfig: ExtractorConfig = {
  enabled: true,
  minTurnsBeforeExtract: 1,
  maxCandidatesPerTurn: 5,
  confidenceThreshold: 0.5,
  autoApproveThreshold: 0.8,
}...

**test/candidate-generator.test.ts** (2026-07-16)
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { CandidateGenerator } from '../dist/candidate-generator.js';

interface MockCall {
  sql: string;
  params?: unknown[];
}

function makePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  const calls: MockCall[] = [];
  return {
    pool: {
      query: mock.fn((sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        ...

**src/re-entry-protocol.ts** (2026-07-16)
import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { AgentWorkJournal } from './agent-work-journal.js';
import {
  type BuiltContextInjection,
} from './context-injection-contract.js';
import { buildReentryProvenance } from './reentry-injection-prove...

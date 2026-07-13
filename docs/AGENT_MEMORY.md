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

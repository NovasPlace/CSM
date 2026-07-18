import type { AgentWorkJournal } from './agent-work-journal.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { DatabasePool } from './types.js';

export interface ReentryLayerDependencies {
  pool: DatabasePool;
  memoryManager: MemoryManager;
  selfModel: SelfModelUpdater;
  beliefStore: BeliefKnowledgeConsolidator;
  workJournal: AgentWorkJournal;
}

export interface LayerBuildResult {
  text: string;
  sources: string[];
}

export interface WorkEntry {
  intent: string;
  filesTouched: string[];
}

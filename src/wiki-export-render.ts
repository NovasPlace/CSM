import type { Memory } from './types.js';
import type { ExportSnapshot } from './wiki-export-model.js';
import {
  categoryForMemory,
  renderEntityNote,
  renderIndexPage,
  renderMemoryNote,
  type IndexPageData,
  type RenderedNote,
} from './wiki-note-renderer.js';

export function renderSnapshotNotes(
  snapshot: ExportSnapshot,
  importanceThreshold: number,
): RenderedNote[] {
  const ids = new Set(snapshot.memories.map(memory => memory.id));
  const memoryNotes = snapshot.memories.map(memory => renderMemoryNote(
    memory,
    snapshot.links.get(memory.id) ?? [],
    ids,
    importanceThreshold,
    !isPrimaryEligible(memory, importanceThreshold),
  ));
  const entityNotes = snapshot.entities.map(renderEntityNote);
  return [...memoryNotes, ...entityNotes, renderIndexNote(snapshot, importanceThreshold)];
}

function isPrimaryEligible(
  memory: Pick<Memory, 'memoryType' | 'metadata' | 'importance'>,
  threshold: number,
): boolean {
  const metadata = memory.metadata as Record<string, unknown>;
  if (memory.memoryType === 'lesson' || memory.memoryType === 'procedural') return true;
  if (memory.memoryType === 'preference' && metadata.source_kind === 'decision') return true;
  if (metadata.promotion_source === 'belief_promotion_engine') return true;
  const thresholdType = ['workspace', 'repo', 'episodic', 'conversation'].includes(memory.memoryType);
  return thresholdType && memory.importance >= threshold;
}

function renderIndexNote(snapshot: ExportSnapshot, threshold: number): RenderedNote {
  const byCategory: Record<string, number> = { entities: snapshot.entities.length };
  const byType: Record<string, number> = {};
  for (const memory of snapshot.memories) {
    const category = categoryForMemory(memory, threshold, false);
    byCategory[category] = (byCategory[category] ?? 0) + 1;
    byType[memory.memoryType] = (byType[memory.memoryType] ?? 0) + 1;
  }
  return renderIndexPage(buildIndexData(snapshot, byCategory, byType));
}

function buildIndexData(
  snapshot: ExportSnapshot,
  byCategory: Record<string, number>,
  byType: Record<string, number>,
): IndexPageData {
  return {
    totalNotes: snapshot.memories.length + snapshot.entities.length,
    byCategory,
    byType,
    recentLessons: topMemories(snapshot, memory =>
      memory.memoryType === 'lesson' || memory.memoryType === 'procedural'),
    recentDecisions: latestMemories(snapshot, memory =>
      memory.memoryType === 'preference'
        && (memory.metadata as Record<string, unknown>).source_kind === 'decision'),
    recentKnowledge: topMemories(snapshot, memory =>
      (memory.metadata as Record<string, unknown>).promotion_source === 'belief_promotion_engine'),
    entityHotlist: snapshot.entities.slice(0, 20).map(entity => ({
      conceptValue: entity.conceptValue,
      refCount: entity.referencedByMemoryIds.length,
    })),
  };
}

function topMemories(snapshot: ExportSnapshot, filter: (memory: Memory) => boolean) {
  return snapshot.memories.filter(filter).sort((a, b) => b.importance - a.importance).slice(0, 10);
}

function latestMemories(snapshot: ExportSnapshot, filter: (memory: Memory) => boolean) {
  return snapshot.memories.filter(filter)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 10);
}

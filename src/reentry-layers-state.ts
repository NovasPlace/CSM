import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefEntry, SelfModelCapability } from './types.js';
import type { ReEntryLayerText } from './reentry-layers-foundation.js';
import type { ContextInjectionItem } from './context-injection-contract.js';

export async function buildCapabilitiesLayer(
  selfModel: SelfModelUpdater,
): Promise<ReEntryLayerText> {
  const sources = ['self_model_capabilities'];
  let capabilities: SelfModelCapability[];
  try {
    capabilities = await selfModel.getAllCapabilities();
  } catch (error) {
    logDegradation('capabilities', error);
    return { text: '## Capabilities\nNo capability data available.', sources, items: [] };
  }
  if (capabilities.length === 0) {
    return { text: '## Capabilities\nNo capability data recorded.', sources, items: [] };
  }
  const lines = capabilities.filter((item) => item.confidence > 0.4 || item.driftWarning)
    .sort((a, b) => b.confidence - a.confidence).slice(0, 5).map(capabilityLine);
  const text = lines.length > 0
    ? `## Capabilities\n${lines.join('\n')}`
    : '## Capabilities\nNo high-confidence capabilities yet.';
  const items: ContextInjectionItem[] = [{
    layerName: 'capabilities', sourceKind: 'derived_state', sourceId: 'self_model',
    memoryId: null, position: 0, selectionRank: null, selectionScore: null,
    selectionReason: null, disposition: 'injected', provenanceGranularity: 'layer',
    charCount: text.length, metadata: { capabilityCount: capabilities.length },
  }];
  return { text, sources, items };
}

export async function buildBeliefsLayer(
  beliefStore: BeliefKnowledgeConsolidator,
): Promise<ReEntryLayerText> {
  const sources = ['belief_knowledge_store'];
  let beliefs: BeliefEntry[];
  try {
    const [opinions, worldviews] = await Promise.all([
      beliefStore.getBeliefsByKind('opinion'), beliefStore.getBeliefsByKind('worldview'),
    ]);
    beliefs = [...opinions, ...worldviews];
  } catch (error) {
    logDegradation('beliefs', error);
    return { text: '## Beliefs\nNo belief data available.', sources, items: [] };
  }
  const lines = beliefs.filter((item) => item.status === 'promoted')
    .sort((a, b) => b.confidence - a.confidence).slice(0, 5)
    .map((item) => `- [${item.beliefKind}] ${item.subject}: ${item.claim.substring(0, 100)}`);
  const text = lines.length > 0
    ? `## Beliefs\n${lines.join('\n')}`
    : '## Beliefs\nNo consolidated beliefs yet.';
  const items: ContextInjectionItem[] = [{
    layerName: 'beliefs', sourceKind: 'derived_state', sourceId: 'belief_knowledge_store',
    memoryId: null, position: 0, selectionRank: null, selectionScore: null,
    selectionReason: null, disposition: 'injected', provenanceGranularity: 'layer',
    charCount: text.length, metadata: { beliefCount: beliefs.length },
  }];
  return { text, sources, items };
}

export async function buildRecentLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<ReEntryLayerText> {
  const sources = ['memories (recent)', 'experience_packets'];
  const memories = await memoryManager.listMemories({ projectId, limit: 3, sortBy: 'recent' });
  if (memories.length === 0) return { text: '## Recent Context\nNo recent activity.', sources, items: [] };
  const lines = memories.map((memory) => {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.slice(0, 3).join(',')}]` : '';
    return `- ${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}${tags}`;
  });
  const items: ContextInjectionItem[] = memories.map((memory, index) => ({
    layerName: 'recent', sourceKind: 'memory', sourceId: `memory:${memory.id}`,
    memoryId: memory.id, position: index, selectionRank: index,
    selectionScore: null, selectionReason: 'recent_session',
    disposition: 'injected', provenanceGranularity: 'item',
    charCount: lines[index].length, metadata: { tags: memory.tags.slice(0, 3) },
  }));
  return { text: `## Recent Context\n${lines.join('\n')}`, sources, items };
}

export async function buildConstraintsLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<ReEntryLayerText> {
  const sources = ['memories (lesson, tagged:constraint)', 'memory_governance'];
  const lessons = await memoryManager.listMemories({
    projectId, type: 'lesson', limit: 5, sortBy: 'important',
  });
  const constraints = lessons.filter((memory) => memory.tags.includes('constraint')
    || memory.tags.includes('do-not') || memory.importance >= 0.8);
  const target = constraints.length > 0 ? constraints : lessons.slice(0, 3);
  if (target.length === 0) return { text: '## Constraints\nNo hard constraints recorded.', sources, items: [] };
  const lines = target.slice(0, 5).map((memory) =>
    `- ${memory.content.substring(0, 120)}${memory.content.length > 120 ? '...' : ''}`);
  const items: ContextInjectionItem[] = target.slice(0, 5).map((memory, index) => ({
    layerName: 'constraints', sourceKind: 'memory', sourceId: `memory:${memory.id}`,
    memoryId: memory.id, position: index, selectionRank: index,
    selectionScore: memory.importance, selectionReason: 'importance_rank',
    disposition: 'injected', provenanceGranularity: 'item',
    charCount: lines[index].length, metadata: { tags: memory.tags },
  }));
  return { text: `## Constraints\n${lines.join('\n')}`, sources, items };
}

function capabilityLine(item: SelfModelCapability): string {
  const drift = item.driftWarning ? ' [DRIFT WARNING]' : '';
  return `- ${item.capability}: confidence ${(item.confidence * 100).toFixed(0)}%, ${item.successCount} successes${drift}`;
}

function logDegradation(layer: string, value: unknown): void {
  const error = value instanceof Error ? value : new Error(String(value));
  getLogger().error(`Re-entry ${layer} source unavailable`, error);
}

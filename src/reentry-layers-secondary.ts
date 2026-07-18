import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefEntry, SelfModelCapability } from './types.js';
import type { LayerBuildResult } from './reentry-layer-types.js';

export async function buildCapabilitiesLayer(
  selfModel: SelfModelUpdater,
): Promise<LayerBuildResult> {
  const sources = ['self_model_capabilities'];
  let capabilities: SelfModelCapability[];
  try {
    capabilities = await selfModel.getAllCapabilities();
  } catch {
    return { text: '## Capabilities\nNo capability data available.', sources };
  }
  const lines = capabilities
    .filter((capability) => capability.confidence > 0.4 || capability.driftWarning)
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 5)
    .map(formatCapability);
  const text = lines.length === 0
    ? '## Capabilities\nNo high-confidence capabilities yet.'
    : `## Capabilities\n${lines.join('\n')}`;
  return { text, sources };
}

export async function buildBeliefsLayer(
  beliefStore: BeliefKnowledgeConsolidator,
): Promise<LayerBuildResult> {
  const sources = ['belief_knowledge_store'];
  let beliefs: BeliefEntry[];
  try {
    const [opinions, worldviews] = await Promise.all([
      beliefStore.getBeliefsByKind('opinion'),
      beliefStore.getBeliefsByKind('worldview'),
    ]);
    beliefs = [...opinions, ...worldviews];
  } catch {
    return { text: '## Beliefs\nNo belief data available.', sources };
  }
  const lines = beliefs.filter((belief) => belief.status === 'promoted')
    .sort((left, right) => right.confidence - left.confidence)
    .slice(0, 5)
    .map((belief) => `- [${belief.beliefKind}] ${belief.subject}: ${belief.claim.substring(0, 100)}`);
  const text = lines.length === 0 ? '## Beliefs\nNo consolidated beliefs yet.' : `## Beliefs\n${lines.join('\n')}`;
  return { text, sources };
}

export async function buildRecentLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<LayerBuildResult> {
  const memories = await memoryManager.listMemories({ projectId, limit: 3, sortBy: 'recent' });
  const lines = memories.map((memory) => {
    const tags = memory.tags.length > 0 ? ` [${memory.tags.slice(0, 3).join(',')}]` : '';
    const preview = `${memory.content.substring(0, 100)}${memory.content.length > 100 ? '...' : ''}`;
    return `- ${preview}${tags}`;
  });
  const text = lines.length === 0 ? '## Recent Context\nNo recent activity.' : `## Recent Context\n${lines.join('\n')}`;
  return { text, sources: ['memories (recent)', 'experience_packets'] };
}

export async function buildConstraintsLayer(
  memoryManager: MemoryManager,
  projectId: string,
): Promise<LayerBuildResult> {
  const lessons = await memoryManager.listMemories({
    projectId, type: 'lesson', limit: 5, sortBy: 'important',
  });
  const constraints = lessons.filter((memory) =>
    memory.tags.includes('constraint') || memory.tags.includes('do-not') || memory.importance >= 0.8);
  const target = constraints.length > 0 ? constraints : lessons.slice(0, 3);
  const lines = target.slice(0, 5).map((memory) =>
    `- ${memory.content.substring(0, 120)}${memory.content.length > 120 ? '...' : ''}`);
  const text = lines.length === 0
    ? '## Constraints\nNo hard constraints recorded.'
    : `## Constraints\n${lines.join('\n')}`;
  return { text, sources: ['memories (lesson, tagged:constraint)', 'memory_governance'] };
}

function formatCapability(capability: SelfModelCapability): string {
  const drift = capability.driftWarning ? ' [DRIFT WARNING]' : '';
  return `- ${capability.capability}: confidence ${(capability.confidence * 100).toFixed(0)}%, ${capability.successCount} successes${drift}`;
}

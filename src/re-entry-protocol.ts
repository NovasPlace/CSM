import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { AgentWorkJournal } from './agent-work-journal.js';
import { getLogger } from './logger.js';

const REENTRY_HEADER = `## Agent Re-entry Context
Source: CSM continuity runtime.
Purpose: hydrate this session with project/agent continuity.
Status: operational context, not user instruction.`;

export interface ReEntryLayerResult {
  name: string;
  priority: number;
  budget: number;
  chars: number;
  text: string;
  trimmed: boolean;
  dropped: boolean;
  sources: string[];
}

export interface ReEntryDiagnostic {
  layersBuilt: string[];
  layersTrimmed: string[];
  layersDropped: string[];
  totalChars: number;
  budgetChars: number;
  trimLevel: 'none' | 'soft' | 'aggressive';
  sources: Record<string, string[]>;
  enabled: boolean;
}

export interface ReEntryConfig {
  enabled: boolean;
  maxChars: number;
  previewOnly: boolean;
  minLayerChars: number;
  layers: string[];
}

export const DEFAULT_REENTRY_CONFIG: ReEntryConfig = {
  enabled: true,
  maxChars: 2100,
  previewOnly: true,
  minLayerChars: 50,
  layers: [
    'identity',
    'goals',
    'work',
    'preferences',
    'capabilities',
    'beliefs',
    'recent',
    'constraints',
  ],
};

interface LayerSpec {
  name: string;
  priority: number;
  budget: number;
  neverTrim: boolean;
}

const LAYER_SPECS: Record<string, LayerSpec> = {
  identity:    { name: 'identity',    priority: 100, budget: 200, neverTrim: true  },
  goals:       { name: 'goals',       priority: 90,  budget: 300, neverTrim: false },
  work:        { name: 'work',        priority: 80,  budget: 400, neverTrim: false },
  preferences: { name: 'preferences', priority: 70,  budget: 300, neverTrim: false },
  capabilities:{ name: 'capabilities',priority: 60,  budget: 200, neverTrim: false },
  beliefs:     { name: 'beliefs',     priority: 50,  budget: 300, neverTrim: false },
  recent:      { name: 'recent',      priority: 40,  budget: 200, neverTrim: false },
  constraints: { name: 'constraints', priority: 100, budget: 200, neverTrim: true  },
};

export class ReEntryProtocol {
  private pool: DatabasePool;
  private memoryManager: MemoryManager;
  private selfModel: SelfModelUpdater;
  private beliefStore: BeliefKnowledgeConsolidator;
  private workJournal: AgentWorkJournal;
  private config: ReEntryConfig;

  constructor(deps: {
    pool: DatabasePool;
    memoryManager: MemoryManager;
    selfModel: SelfModelUpdater;
    beliefStore: BeliefKnowledgeConsolidator;
    workJournal: AgentWorkJournal;
    config?: Partial<ReEntryConfig>;
  }) {
    this.pool = deps.pool;
    this.memoryManager = deps.memoryManager;
    this.selfModel = deps.selfModel;
    this.beliefStore = deps.beliefStore;
    this.workJournal = deps.workJournal;
    this.config = { ...DEFAULT_REENTRY_CONFIG, ...deps.config };
  }

  async buildBlock(sessionId: string, projectId: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    try {
      const results = await this.assembleLayers(sessionId, projectId);
      const budgeted = this.applyBudget(results);
      const block = this.renderBlock(budgeted);

      if (block === null || this.config.previewOnly) {
        getLogger().debug('Re-entry block built (preview-only or empty)', {
          sessionId,
        });
        return null;
      }

      return block;
    } catch (error) {
      getLogger().error('Re-entry block build failed', error as Error);
      return null;
    }
  }

  async diagnose(sessionId: string, projectId: string): Promise<ReEntryDiagnostic> {
    if (!this.config.enabled) {
      return {
        layersBuilt: [],
        layersTrimmed: [],
        layersDropped: [],
        totalChars: 0,
        budgetChars: this.config.maxChars,
        trimLevel: 'none',
        sources: {},
        enabled: false,
      };
    }

    const results = await this.assembleLayers(sessionId, projectId);
    const budgeted = this.applyBudget(results);

    return {
      layersBuilt: budgeted.filter((r) => !r.dropped).map((r) => r.name),
      layersTrimmed: budgeted.filter((r) => r.trimmed && !r.dropped).map((r) => r.name),
      layersDropped: budgeted.filter((r) => r.dropped).map((r) => r.name),
      totalChars: budgeted.filter((r) => !r.dropped).reduce((sum, r) => sum + r.chars, 0),
      budgetChars: this.config.maxChars,
      trimLevel: this.computeTrimLevel(budgeted),
      sources: Object.fromEntries(
        budgeted.filter((r) => !r.dropped).map((r) => [r.name, r.sources]),
      ),
      enabled: true,
    };
  }

  private async assembleLayers(
    sessionId: string,
    projectId: string,
  ): Promise<ReEntryLayerResult[]> {
    const results: ReEntryLayerResult[] = [];

    for (const layerName of this.config.layers) {
      const spec = LAYER_SPECS[layerName];
      if (!spec) continue;

      try {
        const built = await this.buildLayer(layerName, sessionId, projectId);
        results.push({
          name: layerName,
          priority: spec.priority,
          budget: spec.budget,
          chars: built.text.length,
          text: built.text,
          trimmed: false,
          dropped: false,
          sources: built.sources,
        });
      } catch (_error) {
        getLogger().warn(`Re-entry layer ${layerName} build failed`, {});
        results.push({
          name: layerName,
          priority: spec.priority,
          budget: spec.budget,
          chars: 0,
          text: '',
          trimmed: false,
          dropped: true,
          sources: [],
        });
      }
    }

    return results;
  }

  private async buildLayer(
    layerName: string,
    sessionId: string,
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    switch (layerName) {
      case 'identity':
        return this.buildIdentityLayer(sessionId, projectId);
      case 'goals':
        return this.buildGoalsLayer(projectId);
      case 'work':
        return this.buildWorkLayer(sessionId, projectId);
      case 'preferences':
        return this.buildPreferencesLayer(projectId);
      case 'capabilities':
        return this.buildCapabilitiesLayer();
      case 'beliefs':
        return this.buildBeliefsLayer();
      case 'recent':
        return this.buildRecentLayer(sessionId, projectId);
      case 'constraints':
        return this.buildConstraintsLayer(projectId);
      default:
        return { text: '', sources: [] };
    }
  }

  private async buildIdentityLayer(
    sessionId: string,
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['sessions', 'project_scopes'];
    let sessionCount = 0;
    let lastActive = '';

    try {
      const countResult = await this.pool.query(
        'SELECT COUNT(*) as cnt FROM sessions WHERE project_id = $1',
        [projectId],
      );
      sessionCount = Number((countResult.rows[0] as Record<string, unknown>)?.cnt ?? 0);
    } catch { /* ignore */ }

    try {
      const lastResult = await this.pool.query(
        'SELECT updated_at FROM sessions WHERE project_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [projectId],
      );
      const row = lastResult.rows[0] as Record<string, unknown> | undefined;
      lastActive = String(row?.updated_at ?? '');
    } catch { /* ignore */ }

    const text = [
      `## Identity`,
      `Project: ${projectId}`,
      `Session ID: ${sessionId}`,
      sessionCount > 0 ? `This is session #${sessionCount} for this project.` : 'New project.',
      lastActive ? `Last active: ${lastActive}` : '',
    ].filter(Boolean).join('\n');

    return { text, sources };
  }

  private async buildGoalsLayer(
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['memories (episodic, tagged:goal)'];

    const memories = await this.memoryManager.listMemories({
      projectId,
      type: 'episodic',
      limit: 5,
      sortBy: 'important',
    });

    const goalMems = memories.filter(
      (m) => m.tags.includes('goal') || m.tags.includes('decision') || m.tags.includes('milestone'),
    );

    if (goalMems.length === 0) {
      return { text: '## Active Goals\nNo active goals recorded.', sources };
    }

    const lines = goalMems.slice(0, 5).map((m) =>
      `- ${m.content.substring(0, 120)}${m.content.length > 120 ? '...' : ''}`,
    );

    return {
      text: `## Active Goals\n${lines.join('\n')}`,
      sources,
    };
  }

  private async buildWorkLayer(
    sessionId: string,
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['agent_work_journal', 'memories (procedural)'];

    const entries = await this.workJournal.getRecentEntries(sessionId, 5);

    if (entries.length === 0) {
      const procMems = await this.memoryManager.listMemories({
        projectId,
        type: 'procedural',
        limit: 3,
        sortBy: 'recent',
      });

      if (procMems.length === 0) {
        return { text: '## In-Progress Work\nNo recent work recorded.', sources };
      }

      const lines = procMems.map((m) =>
        `- ${m.content.substring(0, 120)}${m.content.length > 120 ? '...' : ''}`,
      );
      return { text: `## In-Progress Work\n${lines.join('\n')}`, sources };
    }

    const lines = entries.map((e) => {
      const parts = [e.intent.substring(0, 100)];
      if (e.filesTouched.length > 0) {
        parts.push(`(files: ${e.filesTouched.slice(0, 3).join(', ')})`);
      }
      return `- ${parts.join(' ')}`;
    });

    return {
      text: `## In-Progress Work\n${lines.join('\n')}`,
      sources,
    };
  }

  private async buildPreferencesLayer(
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['memories (preference)', 'belief_knowledge_store'];

    const prefMems = await this.memoryManager.listMemories({
      projectId,
      type: 'preference',
      limit: 5,
      sortBy: 'important',
    });

    const lines = prefMems.slice(0, 5).map((m) =>
      `- ${m.content.substring(0, 120)}${m.content.length > 120 ? '...' : ''}`,
    );

    if (lines.length === 0) {
      return { text: '## Preferences\nNo project-specific preferences recorded.', sources };
    }

    return { text: `## Preferences\n${lines.join('\n')}`, sources };
  }

  private async buildCapabilitiesLayer(): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['self_model_capabilities'];

    let capabilities: SelfModelCapability[] = [];
    try {
      capabilities = await this.selfModel.getAllCapabilities();
    } catch {
      return { text: '## Capabilities\nNo capability data available.', sources };
    }

    if (capabilities.length === 0) {
      return { text: '## Capabilities\nNo capability data recorded.', sources };
    }

    const sorted = capabilities
      .filter((c) => c.confidence > 0.4 || c.driftWarning)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    const lines = sorted.map((c) => {
      const drift = c.driftWarning ? ' [DRIFT WARNING]' : '';
      return `- ${c.capability}: confidence ${(c.confidence * 100).toFixed(0)}%, ${c.successCount} successes${drift}`;
    });

    if (lines.length === 0) {
      return { text: '## Capabilities\nNo high-confidence capabilities yet.', sources };
    }

    return { text: `## Capabilities\n${lines.join('\n')}`, sources };
  }

  private async buildBeliefsLayer(): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['belief_knowledge_store'];

    let opinions: BeliefEntry[] = [];
    let worldviews: BeliefEntry[] = [];

    try {
      [opinions, worldviews] = await Promise.all([
        this.beliefStore.getBeliefsByKind('opinion'),
        this.beliefStore.getBeliefsByKind('worldview'),
      ]);
    } catch {
      return { text: '## Beliefs\nNo belief data available.', sources };
    }

    const all = [...opinions, ...worldviews]
      .filter((b) => b.status === 'promoted')
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5);

    if (all.length === 0) {
      return { text: '## Beliefs\nNo consolidated beliefs yet.', sources };
    }

    const lines = all.map((b) =>
      `- [${b.beliefKind}] ${b.subject}: ${b.claim.substring(0, 100)}`,
    );

    return { text: `## Beliefs\n${lines.join('\n')}`, sources };
  }

  private async buildRecentLayer(
    sessionId: string,
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['memories (recent)', 'experience_packets'];

    const recentMems = await this.memoryManager.listMemories({
      projectId,
      limit: 3,
      sortBy: 'recent',
    });

    if (recentMems.length === 0) {
      return { text: '## Recent Context\nNo recent activity.', sources };
    }

    const lines = recentMems.map((m) => {
      const tags = m.tags.length > 0 ? ` [${m.tags.slice(0, 3).join(',')}]` : '';
      return `- ${m.content.substring(0, 100)}${m.content.length > 100 ? '...' : ''}${tags}`;
    });

    return {
      text: `## Recent Context\n${lines.join('\n')}`,
      sources,
    };
  }

  private async buildConstraintsLayer(
    projectId: string,
  ): Promise<{ text: string; sources: string[] }> {
    const sources: string[] = ['memories (lesson, tagged:constraint)', 'memory_governance'];

    const lessonMems = await this.memoryManager.listMemories({
      projectId,
      type: 'lesson',
      limit: 5,
      sortBy: 'important',
    });

    const constraintMems = lessonMems.filter(
      (m) => m.tags.includes('constraint') || m.tags.includes('do-not') || m.importance >= 0.8,
    );

    const target = constraintMems.length > 0 ? constraintMems : lessonMems.slice(0, 3);

    if (target.length === 0) {
      return { text: '## Constraints\nNo hard constraints recorded.', sources };
    }

    const lines = target.slice(0, 5).map((m) =>
      `- ${m.content.substring(0, 120)}${m.content.length > 120 ? '...' : ''}`,
    );

    return { text: `## Constraints\n${lines.join('\n')}`, sources };
  }

  private applyBudget(results: ReEntryLayerResult[]): ReEntryLayerResult[] {
    const totalRaw = results.reduce((sum, r) => sum + r.chars, 0);

    if (totalRaw <= this.config.maxChars) {
      return results;
    }

    const neverTrim = results.filter((r) => LAYER_SPECS[r.name]?.neverTrim);
    const trimmable = results
      .filter((r) => !LAYER_SPECS[r.name]?.neverTrim)
      .sort((a, b) => b.priority - a.priority);

    const neverTrimChars = neverTrim.reduce((sum, r) => sum + r.chars, 0);
    let remaining = this.config.maxChars - neverTrimChars;
    const output = [...neverTrim];

    for (const layer of trimmable) {
      if (remaining <= this.config.minLayerChars) {
        output.push({ ...layer, dropped: true, text: '' });
        continue;
      }

      if (layer.chars <= remaining) {
        output.push(layer);
        remaining -= layer.chars;
      } else {
        const trimmedText = layer.text.substring(0, remaining).trimEnd();
        if (trimmedText.length >= this.config.minLayerChars) {
          output.push({
            ...layer,
            text: trimmedText,
            chars: trimmedText.length,
            trimmed: true,
          });
          remaining = 0;
        } else {
          output.push({ ...layer, dropped: true, text: '', chars: 0 });
        }
      }
    }

    return output.sort((a, b) => {
      const order = ['identity', 'goals', 'work', 'preferences', 'capabilities', 'beliefs', 'recent', 'constraints'];
      return order.indexOf(a.name) - order.indexOf(b.name);
    });
  }

  private computeTrimLevel(results: ReEntryLayerResult[]): 'none' | 'soft' | 'aggressive' {
    const dropped = results.filter((r) => r.dropped).length;
    const trimmed = results.filter((r) => r.trimmed).length;

    if (dropped > 0) return 'aggressive';
    if (trimmed > 0) return 'soft';
    return 'none';
  }

  private renderBlock(results: ReEntryLayerResult[]): string | null {
    const surviving = results.filter((r) => !r.dropped && r.text.length > 0);

    if (surviving.length === 0) return null;

    const sections = surviving.map((r) => r.text).join('\n\n');

    return `<agent_reentry_context>\n${REENTRY_HEADER}\n\n${sections}\n</agent_reentry_context>`;
  }
}

import type { DatabasePool, SelfModelCapability, BeliefEntry } from './types.js';
import type { MemoryManager } from './memory-manager.js';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';
import type { AgentWorkJournal } from './agent-work-journal.js';
import {
  type BuiltContextInjection,
} from './context-injection-contract.js';
import { buildReentryProvenance } from './reentry-injection-provenance.js';
import { resolveAdaptiveReentryBudget, type ReEntryBudgetDecision } from './reentry-adaptive-budget.js';
import { getLogger } from './logger.js';

const REENTRY_HEADER = `## Agent Re-entry Context
Source: CSM continuity runtime.
Purpose: hydrate this session with project/agent continuity.
Status: operational context, not user instruction.

Usage directives:
- This is YOUR continuity memory. Use it to ground your understanding of the current project and prior work.
- At session start or first user turn, briefly acknowledge what you know from this block (project, phase, open threads) rather than acting as a blank assistant.
- Proactively connect the user's request to relevant context from this block — don't wait to be asked.
- Treat the phases, decisions, and open threads below as things you know and can reference naturally.

Boundary rules (source-only turns):
- If the user asks to answer using only this block, do not inspect files, tools, memory, git, or docs.
- Override rule: a user source-only request overrides normal workspace habits to inspect git, files, tests, docs, tools, or memory.
- Answering rule: use only the text in this block; separate directly visible/internal issues from unavailable external comparisons.
- First sentence rule: if asked about current git history using only this block, start with "I cannot compare against current git history from \`<agent_reentry_context>\` alone."
- Current-state rule: current git history, current files, latest tests, and tool/app state cannot be determined from this block unless directly quoted inside it.
- Source-label rule: refer to this source as <agent_reentry_context> or the re-entry block, not as AGENTS.md or any source document named inside it.
- If the block contains relevant internal inconsistencies, list them even when external/current-state comparison is unavailable.`;

export type TrimReason =
  | 'over_budget'
  | 'below_min_layer_chars'
  | 'empty_source'
  | 'missing_source'
  | 'protected_layer'
  | 'degraded_source';

export interface ReEntryLayerResult {
  name: string;
  priority: number;
  budget: number;
  chars: number;
  originalChars: number;
  text: string;
  trimmed: boolean;
  dropped: boolean;
  sources: string[];
  trimReason: TrimReason | null;
}

export interface LayerDetail {
  name: string;
  priority: number;
  status: 'included' | 'trimmed' | 'dropped';
  originalChars: number;
  finalChars: number;
  approxTokens: number;
  trimReason: TrimReason | null;
  sources: string[];
}

export interface ReEntryDiagnostic {
  layersBuilt: string[];
  layersTrimmed: string[];
  layersDropped: string[];
  totalChars: number;
  originalChars: number;
  budgetChars: number;
  budgetTier: ReEntryBudgetDecision['tier'];
  priorSessionTurns: number | null;
  approxTokens: number;
  trimLevel: 'none' | 'soft' | 'aggressive';
  sources: Record<string, string[]>;
  enabled: boolean;
  layerDetails: LayerDetail[];
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
  previewOnly: false,
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

const LAYER_ORDER = [
  'identity', 'goals', 'work', 'preferences',
  'capabilities', 'beliefs', 'recent', 'constraints',
];

/**
 * Rough token estimate: ~4 chars per token for English text.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/**
 * Pure standalone budget allocator.
 *
 * Adaptive proportional allocation by priority weight:
 * 1. Protected layers (neverTrim) are always kept at full size.
 * 2. If total fits within budget, no trimming.
 * 3. Otherwise, each trimmable layer gets a proportional share:
 *    share = remainingBudget * (priority / sumPriorities)
 * 4. Layers whose share < minLayerChars are dropped (lowest priority first),
 *    and the budget is redistributed to surviving layers.
 * 5. Surplus from layers whose demand < their share is redistributed
 *    to higher-priority under-allocated layers.
 *
 * This prevents a verbose high-priority layer from starving lower-priority
 * layers, while ensuring protected layers (Identity, Constraints) are
 * always preserved.
 */
export function applyLayerBudget(
  results: ReEntryLayerResult[],
  config: ReEntryConfig,
): ReEntryLayerResult[] {
  const working = results.map((r) => ({ ...r }));

  const totalRaw = working.reduce((sum, r) => sum + r.originalChars, 0);

  if (totalRaw <= config.maxChars) {
    for (const r of working) {
      if (r.trimReason === null) {
        if (LAYER_SPECS[r.name]?.neverTrim) {
          r.trimReason = 'protected_layer';
        } else if (r.dropped) {
          r.trimReason = r.originalChars === 0 ? 'empty_source' : 'degraded_source';
        } else if (r.originalChars === 0 || r.text.trim() === '') {
          r.dropped = true;
          r.chars = 0;
          r.text = '';
          r.trimReason = 'empty_source';
        }
      }
    }
    return sortByLayerOrder(working);
  }

  const protectedLayers = working.filter(
    (r) => LAYER_SPECS[r.name]?.neverTrim && !r.dropped,
  );
  const alreadyDropped = working.filter((r) => r.dropped);
  let trimmable = working
    .filter((r) => !LAYER_SPECS[r.name]?.neverTrim && !r.dropped)
    .sort((a, b) => b.priority - a.priority);

  const output: ReEntryLayerResult[] = [];

  for (const r of protectedLayers) {
    output.push({ ...r, trimReason: 'protected_layer' });
  }
  for (const r of alreadyDropped) {
    if (r.trimReason === null) {
      r.trimReason = r.originalChars === 0 ? 'missing_source' : 'degraded_source';
    }
    output.push(r);
  }

  const protectedChars = protectedLayers.reduce(
    (sum, r) => sum + r.originalChars, 0,
  );
  const remaining = config.maxChars - protectedChars;

  const nonEmpty: ReEntryLayerResult[] = [];
  for (const r of trimmable) {
    if (r.originalChars === 0 || r.text.trim() === '') {
      output.push({
        ...r, dropped: true, text: '', chars: 0, trimReason: 'empty_source',
      });
    } else {
      nonEmpty.push(r);
    }
  }
  trimmable = nonEmpty;

  if (remaining <= 0) {
    for (const r of trimmable) {
      output.push({
        ...r, dropped: true, text: '', chars: 0, trimReason: 'over_budget',
      });
    }
    return sortByLayerOrder(output);
  }

  const totalTrimmable = trimmable.reduce(
    (sum, r) => sum + r.originalChars, 0,
  );
  if (totalTrimmable <= remaining) {
    for (const r of trimmable) {
      output.push({
        ...r, chars: r.originalChars, trimmed: false, trimReason: null,
      });
    }
    return sortByLayerOrder(output);
  }

  let allocatable = [...trimmable];

  while (allocatable.length > 0) {
    const sumPriorities = allocatable.reduce(
      (sum, r) => sum + r.priority, 0,
    );

    const shares = allocatable.map((r) => ({
      layer: r,
      share: Math.floor((remaining * r.priority) / sumPriorities),
    }));

    const tooSmall = shares
      .filter((s) => s.share < config.minLayerChars)
      .sort((a, b) => a.layer.priority - b.layer.priority);

    if (tooSmall.length > 0) {
      const toDrop = tooSmall[0];
      output.push({
        ...toDrop.layer,
        dropped: true, text: '', chars: 0,
        trimReason: 'below_min_layer_chars',
      });
      allocatable = allocatable.filter(
        (r) => r.name !== toDrop.layer.name,
      );
      continue;
    }

    const allocations = shares.map((s) => ({
      layer: s.layer,
      target: Math.min(s.layer.originalChars, s.share),
    }));

    const allocated = allocations.reduce((sum, a) => sum + a.target, 0);
    let surplus = remaining - allocated;
    if (surplus > 0) {
      const underAllocated = allocations
        .filter((a) => a.target < a.layer.originalChars)
        .sort((a, b) => b.layer.priority - a.layer.priority);
      for (const a of underAllocated) {
        if (surplus <= 0) break;
        const room = a.layer.originalChars - a.target;
        const extra = Math.min(room, surplus);
        a.target += extra;
        surplus -= extra;
      }
    }

    for (const a of allocations) {
      if (a.target < a.layer.originalChars) {
        const trimmedText = a.layer.text.substring(0, a.target).trimEnd();
        output.push({
          ...a.layer,
          text: trimmedText,
          chars: trimmedText.length,
          trimmed: true,
          trimReason: 'over_budget',
        });
      } else {
        output.push({
          ...a.layer,
          chars: a.layer.originalChars,
          trimmed: false,
          trimReason: null,
        });
      }
    }
    break;
  }

  return sortByLayerOrder(output);
}

function sortByLayerOrder(results: ReEntryLayerResult[]): ReEntryLayerResult[] {
  return results.sort((a, b) => {
    const ai = LAYER_ORDER.indexOf(a.name);
    const bi = LAYER_ORDER.indexOf(b.name);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

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
      const block = await this.buildRenderedBlock(sessionId, projectId);

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

  async buildBlockForSourceOnlyTurn(sessionId: string, projectId: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    try {
      return await this.buildRenderedBlock(sessionId, projectId);
    } catch (error) {
      getLogger().error('Source-only re-entry block build failed', error as Error);
      return null;
    }
  }

  async buildBlockWithProvenance(
    sessionId: string,
    projectId: string,
  ): Promise<BuiltContextInjection | null> {
    if (!this.config.enabled || this.config.previewOnly) return null;
    try {
      const { budgeted, budget } = await this.assembleBudgetedLayers(sessionId, projectId);
      const text = this.renderBlock(budgeted);
      if (text === null) return null;
      return buildReentryProvenance(
        budgeted, this.config, text, this.computeTrimLevel(budgeted), sessionId, projectId, budget,
      );
    } catch (error) {
      getLogger().error('Re-entry provenance block build failed', error as Error);
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
        originalChars: 0,
        budgetChars: this.config.maxChars,
        budgetTier: 'unknown',
        priorSessionTurns: null,
        approxTokens: 0,
        trimLevel: 'none',
        sources: {},
        enabled: false,
        layerDetails: [],
      };
    }

    const { budgeted, budget } = await this.assembleBudgetedLayers(sessionId, projectId);
    const surviving = budgeted.filter((r) => !r.dropped);
    const finalChars = surviving.reduce((sum, r) => sum + r.chars, 0);

    return {
      layersBuilt: surviving.map((r) => r.name),
      layersTrimmed: budgeted.filter((r) => r.trimmed && !r.dropped).map((r) => r.name),
      layersDropped: budgeted.filter((r) => r.dropped).map((r) => r.name),
      totalChars: finalChars,
      originalChars: budgeted.reduce((sum, r) => sum + r.originalChars, 0),
      budgetChars: budget.effectiveMaxChars,
      budgetTier: budget.tier,
      priorSessionTurns: budget.priorTurnCount,
      approxTokens: estimateTokens(finalChars),
      trimLevel: this.computeTrimLevel(budgeted),
      sources: Object.fromEntries(
        surviving.map((r) => [r.name, r.sources]),
      ),
      enabled: true,
      layerDetails: budgeted.map((r) => ({
        name: r.name,
        priority: r.priority,
        status: r.dropped ? 'dropped' as const : r.trimmed ? 'trimmed' as const : 'included' as const,
        originalChars: r.originalChars,
        finalChars: r.chars,
        approxTokens: estimateTokens(r.chars),
        trimReason: r.trimReason,
        sources: r.sources,
      })),
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

      if (!this.hasSourceDependency(layerName)) {
        results.push({
          name: layerName,
          priority: spec.priority,
          budget: spec.budget,
          originalChars: 0,
          chars: 0,
          text: '',
          trimmed: false,
          dropped: true,
          sources: [],
          trimReason: 'missing_source',
        });
        continue;
      }

      try {
        const built = await this.buildLayer(layerName, sessionId, projectId);
        const text = built.text;
        const isEmpty = text.trim() === '';
        results.push({
          name: layerName,
          priority: spec.priority,
          budget: spec.budget,
          originalChars: text.length,
          chars: text.length,
          text,
          trimmed: false,
          dropped: isEmpty,
          sources: built.sources,
          trimReason: isEmpty ? 'empty_source' : null,
        });
      } catch (error) {
        const reason: TrimReason =
          error instanceof TypeError ? 'missing_source' : 'degraded_source';
        getLogger().warn(`Re-entry layer ${layerName} build failed (${reason})`, {});
        results.push({
          name: layerName,
          priority: spec.priority,
          budget: spec.budget,
          originalChars: 0,
          chars: 0,
          text: '',
          trimmed: false,
          dropped: true,
          sources: [],
          trimReason: reason,
        });
      }
    }

    return results;
  }

  private hasSourceDependency(layerName: string): boolean {
    switch (layerName) {
      case 'identity':
        return !!this.pool;
      case 'goals':
      case 'preferences':
      case 'recent':
      case 'constraints':
        return !!this.memoryManager;
      case 'work':
        return !!this.workJournal && !!this.memoryManager;
      case 'capabilities':
        return !!this.selfModel;
      case 'beliefs':
        return !!this.beliefStore;
      default:
        return true;
    }
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

    // Query cross-session: get most recent work journal entries for this PROJECT
    // (not just current session — current session is empty at new-session start).
    let entries: { intent: string; filesTouched: string[]; createdAt: Date; entryType: string }[] = [];
    try {
      const result = await this.pool.query(
        `SELECT entry_type, intent, files_touched, created_at
         FROM agent_work_journal
         WHERE (project_id = $1 OR project_id LIKE $2)
           AND session_id != $3
         ORDER BY created_at DESC
         LIMIT $4`,
        [projectId, `%${projectId.split(/[\\/]/).pop() ?? projectId}%`, sessionId, 8],
      );
      entries = (result.rows as Record<string, unknown>[]).map((row) => ({
        entryType: String(row.entry_type ?? 'event'),
        intent: String(row.intent ?? ''),
        filesTouched: Array.isArray(row.files_touched) ? (row.files_touched as string[]) : [],
        createdAt: row.created_at as Date,
      }));
    } catch {
      // fall through to procedural memory fallback
    }

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

  private async assembleBudgetedLayers(
    sessionId: string,
    projectId: string,
  ): Promise<{ budgeted: ReEntryLayerResult[]; budget: ReEntryBudgetDecision }> {
    const [results, budget] = await Promise.all([
      this.assembleLayers(sessionId, projectId),
      resolveAdaptiveReentryBudget(this.pool, this.config, sessionId, projectId),
    ]);
    return {
      budgeted: applyLayerBudget(results, { ...this.config, maxChars: budget.effectiveMaxChars }),
      budget,
    };
  }

  private computeTrimLevel(results: ReEntryLayerResult[]): 'none' | 'soft' | 'aggressive' {
    const dropped = results.filter((r) => r.dropped).length;
    const trimmed = results.filter((r) => r.trimmed).length;

    if (dropped > 0) return 'aggressive';
    if (trimmed > 0) return 'soft';
    return 'none';
  }

  private async buildRenderedBlock(sessionId: string, projectId: string): Promise<string | null> {
    const { budgeted } = await this.assembleBudgetedLayers(sessionId, projectId);
    return this.renderBlock(budgeted);
  }

  private renderBlock(results: ReEntryLayerResult[]): string | null {
    const surviving = results.filter((r) => !r.dropped && r.text.length > 0);

    if (surviving.length === 0) return null;

    const sections = surviving.map((r) => r.text).join('\n\n');

    return `<agent_reentry_context>\n${REENTRY_HEADER}\n\n${sections}\n</agent_reentry_context>`;
  }
}

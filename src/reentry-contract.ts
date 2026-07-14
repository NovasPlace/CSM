export {
  BUILDER_VERSION,
  computeConfigHash,
  validateBuiltContextInjection,
} from './context-injection-contract.js';
import type { ContextInjectionItem } from './context-injection-contract.js';
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
  items?: ContextInjectionItem[];
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
  layers: ['identity', 'goals', 'work', 'preferences', 'capabilities', 'beliefs', 'recent', 'constraints'],
};

export interface LayerSpec {
  name: string;
  priority: number;
  budget: number;
  neverTrim: boolean;
}

export const LAYER_SPECS: Readonly<Record<string, LayerSpec>> = {
  identity: { name: 'identity', priority: 100, budget: 200, neverTrim: true },
  goals: { name: 'goals', priority: 90, budget: 300, neverTrim: false },
  work: { name: 'work', priority: 80, budget: 400, neverTrim: false },
  preferences: { name: 'preferences', priority: 70, budget: 300, neverTrim: false },
  capabilities: { name: 'capabilities', priority: 60, budget: 200, neverTrim: false },
  beliefs: { name: 'beliefs', priority: 50, budget: 300, neverTrim: false },
  recent: { name: 'recent', priority: 40, budget: 200, neverTrim: false },
  constraints: { name: 'constraints', priority: 100, budget: 200, neverTrim: true },
};

export const LAYER_ORDER = [
  'identity', 'goals', 'work', 'preferences',
  'capabilities', 'beliefs', 'recent', 'constraints',
];

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

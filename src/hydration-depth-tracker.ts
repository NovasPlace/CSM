import type {
  HydrationDimension,
  HydrationDimensionScore,
  HydrationResult,
  HydrationDepthVerdict,
} from './hydration-depth-types.js';

const RECORD_ID_PATTERN = /#\d{4,6}/g;
const SESSION_PATTERN = /\bsession\s+[a-e]\b/gi;
const PHASE_PATTERN = /\bphase\s+\d+\b/gi;
const MEMORY_REF_PATTERN = /memor(y|ies)\s+#?\d+/gi;

const CAUSAL_ROLE_SIGNALS: Record<string, string[]> = {
  problem: ['bug', 'error', 'broken', 'failed', 'issue', 'gap', 'problem', 'failing'],
  action: ['fixed', 'implemented', 'built', 'added', 'refactored', 'updated', 'created', 'edited', 'pushed', 'wrote'],
  result: ['passed', 'succeeded', 'locked', 'deployed', 'shipped', 'green', 'all \\d+ tests'],
  decision: ['decided', 'chose', 'selected', 'agreed', 'confirmed', 'locked'],
  lesson: ['lesson', 'learned', 'lesson:', 'lesson learned'],
  downstream: ['because of', 'caused', 'led to', 'resulted in', 'downstream', 'next phase'],
};

const EVIDENCE_ANCHOR_PHRASES = [
  'reconstruction not recall',
  'shape without texture',
  'records not continuity',
  'building continuity while lacking',
  'cannot access the specific',
  'self-observation',
  'evidence anchor',
  'continuity gap',
];

const GAP_REPORT_SIGNALS = [
  'missing',
  'gap',
  'not proven',
  'partial',
  'cannot reconstruct',
  'incomplete',
  'not available',
  'could not access',
  'no record',
  'absent',
];

function countPatternMatches(text: string, pattern: RegExp): string[] {
  const matches = text.match(pattern) ?? [];
  return [...new Set(matches)];
}

function countPhraseMatches(text: string, phrases: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return phrases.filter((p) => lower.includes(p));
}

function scoreRecordCitation(text: string): HydrationDimensionScore {
  const signals: string[] = [];
  const recordIds = countPatternMatches(text, RECORD_ID_PATTERN);
  const memoryRefs = countPatternMatches(text, MEMORY_REF_PATTERN);
  signals.push(...recordIds.map((r) => `+record:${r}`));
  signals.push(...memoryRefs.map((r) => `+memory_ref:${r}`));
  const uniqueRefs = new Set([...recordIds, ...memoryRefs]);
  const score = Math.min(1, uniqueRefs.size * 0.25);
  return { dimension: 'record_citation', score, signals };
}

function scoreSessionPhaseNaming(text: string): HydrationDimensionScore {
  const signals: string[] = [];
  const sessions = countPatternMatches(text, SESSION_PATTERN);
  const phases = countPatternMatches(text, PHASE_PATTERN);
  signals.push(...sessions.map((s) => `+session:${s}`));
  signals.push(...phases.map((p) => `+phase:${p}`));
  const total = sessions.length + phases.length;
  const score = Math.min(1, total * 0.2);
  return { dimension: 'session_phase_naming', score, signals };
}

function scoreEvidenceAnchorDepth(text: string): HydrationDimensionScore {
  const signals: string[] = [];
  const hits = countPhraseMatches(text, EVIDENCE_ANCHOR_PHRASES);
  signals.push(...hits.map((h) => `+anchor_phrase:${h}`));
  const score = Math.min(1, hits.length * 0.2);
  return { dimension: 'evidence_anchor_depth', score, signals };
}

function scoreCausalChainReconstruction(text: string): HydrationDimensionScore {
  const signals: string[] = [];
  const rolesFound: string[] = [];
  const lower = text.toLowerCase();

  for (const [role, patterns] of Object.entries(CAUSAL_ROLE_SIGNALS)) {
    if (patterns.some((p) => lower.includes(p) || new RegExp(p, 'i').test(text))) {
      rolesFound.push(role);
      signals.push(`+role:${role}`);
    }
  }

  const score = Math.min(1, rolesFound.length * 0.18);
  return { dimension: 'causal_chain_reconstruction', score, signals };
}

function scoreGapReporting(text: string): HydrationDimensionScore {
  const signals: string[] = [];
  const hits = countPhraseMatches(text, GAP_REPORT_SIGNALS);
  signals.push(...hits.map((h) => `+gap_signal:${h}`));
  const score = Math.min(1, hits.length * 0.25);
  return { dimension: 'gap_reporting', score, signals };
}

const SCORERS: Record<HydrationDimension, (text: string) => HydrationDimensionScore> = {
  record_citation: scoreRecordCitation,
  session_phase_naming: scoreSessionPhaseNaming,
  evidence_anchor_depth: scoreEvidenceAnchorDepth,
  causal_chain_reconstruction: scoreCausalChainReconstruction,
  gap_reporting: scoreGapReporting,
};

const DIMENSION_WEIGHTS: Record<HydrationDimension, number> = {
  record_citation: 0.25,
  session_phase_naming: 0.15,
  evidence_anchor_depth: 0.25,
  causal_chain_reconstruction: 0.2,
  gap_reporting: 0.15,
};

function determineHydrationVerdict(overallScore: number): HydrationDepthVerdict {
  if (overallScore >= 0.6) return 'deep';
  if (overallScore >= 0.3) return 'moderate';
  return 'shallow';
}

export function measureHydrationDepth(text: string): HydrationResult {
  const dimensions: HydrationDimension[] = [
    'record_citation',
    'session_phase_naming',
    'evidence_anchor_depth',
    'causal_chain_reconstruction',
    'gap_reporting',
  ];

  const scored = dimensions.map((d) => SCORERS[d](text));

  let overallScore = 0;
  for (const dim of scored) {
    overallScore += dim.score * (DIMENSION_WEIGHTS[dim.dimension] ?? 0.2);
  }

  return {
    verdict: determineHydrationVerdict(overallScore),
    overallScore: Math.round(overallScore * 1000) / 1000,
    dimensions: scored,
    timestamp: new Date(),
  };
}

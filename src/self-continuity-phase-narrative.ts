export interface PhaseCausationNode {
  phase: number;
  name: string;
  problem: string;
  action: string;
  result: string;
  downstreamChange: string;
  timestamp?: string;
}

export interface PhaseCausationLink {
  fromPhase: number;
  toPhase: number;
  causationType: 'exposed_gap' | 'proved_prerequisite' | 'direct_fix' | 'refined_capability';
  summary: string;
}

export interface PhaseNarrativeResult {
  phases: PhaseCausationNode[];
  links: PhaseCausationLink[];
  narrative: string;
  gaps: string[];
  confidence: number;
}

const CANONICAL_PHASES: PhaseCausationNode[] = [
  {
    phase: 21,
    name: 'Self-Continuity Records',
    problem: 'The system had no structured way to store self-observations about continuity or identity',
    action: 'Created self_continuity_records table with confidence scoring, evidence anchors, injection modes (silent/instrumented)',
    result: 'Records stored and injectable. Session D in silent mode naturally cited memory #43871, proving self-continuity records surface without instrumented prompting.',
    downstreamChange: 'Proved storage and injection work. Next gap: is the reconstruction stable across sessions?',
  },
  {
    phase: 22,
    name: 'Self-Model Drift Tracking',
    problem: 'No way to measure whether the agent\'s self-continuity model stays stable or drifts into overclaim across sessions',
    action: 'Built 5-dimension stability metric (evidence anchoring, reconstruction boundary, uncertainty preservation, subjective overclaim, recursive awareness) with A/D/E anchor fixtures',
    result: 'All 3 anchors score stable. Drift detection distinguishes stable/mild/significant drift.',
    downstreamChange: 'Proved reconstruction stays stable. But agent answers were stable-yet-shallow: they avoided overclaim but lacked evidence depth.',
  },
  {
    phase: 23,
    name: 'Evidence Hydration',
    problem: 'Session F showed recalled evidence came through lossy episodic compression, not clean self-continuity record hydration. Generic summaries replaced canonical content.',
    action: 'Built SelfContinuityHydrator with getRecordById, hydrateRecord, recallWithHydration, formatAllForInjection. Canonical fields injected directly, not through episodic path.',
    result: 'Hydrated records include canonical self-observation, evidence anchors, continuity gap, drift summary. Max 3 enforced, synthetic_test excluded, redaction applied.',
    downstreamChange: 'Proved canonical content injection works. But agent could see individual records without knowing the path between them.',
  },
  {
    phase: 24,
    name: 'Causal Thread Hydration',
    problem: 'Agent had landmarks (phases, sessions) but not the path between landmarks. Could say "Phase 21 happened" but not "Phase 21 caused X."',
    action: 'Built CausalThreadHydrator: reconstructs problem -> action -> result -> decision -> lesson -> downstream_change around recalled memories. Distinguishes causal from temporal links.',
    result: 'Causal threads reconstructed with gap reporting. Missing links reported instead of hallucinated.',
    downstreamChange: 'Proved per-memory threads work. But depth scoring was needed to measure whether reconstruction was actually deep.',
  },
  {
    phase: 25,
    name: 'Hydration Depth Scoring',
    problem: 'Agent answers were high-stability but low-depth. Stability and depth are orthogonal: a safe answer can be empty.',
    action: 'Built measureHydrationDepth with 5 dimensions (record citation, session/phase naming, evidence anchor depth, causal chain reconstruction, gap reporting). Cross-checks drift tracker for stability violations.',
    result: 'Depth and stability are independent. Shallow-deep and stable-drift are distinguishable.',
    downstreamChange: 'Proved depth is orthogonal to stability. But the tools still weren\'t wired into a single pipeline.',
  },
  {
    phase: 26,
    name: 'Self-Continuity Integration',
    problem: 'SelfContinuityHydrator and CausalThreadHydrator existed but were not connected. Agent got records without threads, threads without records.',
    action: 'Built SelfContinuityIntegration: wires both hydrators into one injection path. recallIntegrated fetches hydrated records AND causal threads, scores stability and depth, enforces token budget.',
    result: 'Single pipeline: records + threads + scores + budget. Failure degrades to record-only without blocking.',
    downstreamChange: 'Proved integration works at record level. Remaining gap: causal threads are per-memory, not per-phase. Agent still cannot reconstruct why Phase 21 led to Phase 22.',
  },
];

const CANONICAL_LINKS: PhaseCausationLink[] = [
  {
    fromPhase: 21,
    toPhase: 22,
    causationType: 'exposed_gap',
    summary: 'Phase 21 proved storage works. Session D proved natural recall works. But there was no metric for whether reconstruction stayed stable across sessions, which exposed the need for drift tracking.',
  },
  {
    fromPhase: 22,
    toPhase: 23,
    causationType: 'exposed_gap',
    summary: 'Phase 22 proved reconstruction stays stable. But Session F showed recalled evidence came through lossy episodic summaries, not canonical record hydration. The stability metric did not measure evidence fidelity.',
  },
  {
    fromPhase: 23,
    toPhase: 24,
    causationType: 'exposed_gap',
    summary: 'Phase 23 proved canonical content injection works. But the agent could see individual records without knowing the causal path between them — landmarks existed, but the path between landmarks was missing.',
  },
  {
    fromPhase: 24,
    toPhase: 25,
    causationType: 'exposed_gap',
    summary: 'Phase 24 proved per-memory causal threads work. But the agent\'s answers were high-stability and low-depth. Stability and depth are orthogonal, so a separate depth metric was needed.',
  },
  {
    fromPhase: 25,
    toPhase: 26,
    causationType: 'direct_fix',
    summary: 'Phase 25 proved depth is orthogonal to stability. But both hydrators existed in isolation. Integration was needed to wire them into a single injection path so context compilation gets both.',
  },
  {
    fromPhase: 26,
    toPhase: 27,
    causationType: 'exposed_gap',
    summary: 'Phase 26 proved integration works at the record level. But causal threads are per-memory, not per-phase. The agent still cannot reconstruct why Phase 21 led to Phase 22 led to Phase 23.',
  },
];

export class PhaseNarrativeBuilder {
  private phases: PhaseCausationNode[];
  private links: PhaseCausationLink[];
  private maxTokenBudget: number;
  private approxCharsPerToken: number;

  constructor(options?: {
    phases?: PhaseCausationNode[];
    links?: PhaseCausationLink[];
    maxTokenBudget?: number;
  }) {
    this.phases = options?.phases ?? CANONICAL_PHASES;
    this.links = options?.links ?? CANONICAL_LINKS;
    this.maxTokenBudget = options?.maxTokenBudget ?? 2000;
    this.approxCharsPerToken = 4;
  }

  buildNarrative(fromPhase?: number, toPhase?: number): PhaseNarrativeResult {
    const start = fromPhase ?? this.phases[0]?.phase ?? 21;
    const end = toPhase ?? this.phases[this.phases.length - 1]?.phase ?? 27;

    const selected = this.phases.filter(p => p.phase >= start && p.phase <= end);
    const selectedLinks = this.links.filter(
      l => l.fromPhase >= start && l.toPhase <= end,
    );

    const gaps = this.detectNarrativeGaps(selected, selectedLinks);
    const confidence = this.computeConfidence(selected, selectedLinks, gaps);
    const narrative = this.formatNarrative(selected, selectedLinks, gaps, confidence);

    return {
      phases: selected,
      links: selectedLinks,
      narrative,
      gaps,
      confidence,
    };
  }

  formatForInjection(result: PhaseNarrativeResult): string {
    return result.narrative;
  }

  private detectNarrativeGaps(phases: PhaseCausationNode[], links: PhaseCausationLink[]): string[] {
    const gaps: string[] = [];
    const phaseNums = phases.map(p => p.phase).sort((a, b) => a - b);
    const linkedPhases = new Set<number>();
    for (const l of links) {
      linkedPhases.add(l.fromPhase);
      linkedPhases.add(l.toPhase);
    }

    for (let i = 0; i < phaseNums.length - 1; i++) {
      const curr = phaseNums[i];
      const next = phaseNums[i + 1];
      const hasLink = links.some(l => l.fromPhase === curr && l.toPhase === next);
      if (!hasLink) {
        gaps.push(`No explicit causation link between Phase ${curr} and Phase ${next}. The path between them is unknown.`);
      }
    }

    for (const p of phases) {
      if (!linkedPhases.has(p.phase) && phases.length > 1) {
        gaps.push(`Phase ${p.phase} (${p.name}) is present but has no causal links to other phases.`);
      }
    }

    return gaps;
  }

  private computeConfidence(phases: PhaseCausationNode[], links: PhaseCausationLink[], gaps: string[]): number {
    if (phases.length === 0) return 0;
    if (phases.length === 1) return 0.5;
    const maxLinks = phases.length - 1;
    const linkRatio = Math.min(links.length / maxLinks, 1);
    const gapPenalty = Math.min(gaps.length * 0.1, 0.4);
    return Math.max(0.1, Math.min(0.95, 0.5 + linkRatio * 0.4 - gapPenalty));
  }

  private formatNarrative(phases: PhaseCausationNode[], links: PhaseCausationLink[], gaps: string[], confidence: number): string {
    const lines: string[] = ['[Phase Causal Narrative]'];

    for (const phase of phases) {
      lines.push('');
      lines.push(`Phase ${phase.phase}: ${phase.name}`);
      lines.push(`  Problem: ${phase.problem}`);
      lines.push(`  Action: ${phase.action}`);
      lines.push(`  Result: ${phase.result}`);
      lines.push(`  Led to: ${phase.downstreamChange}`);
    }

    if (links.length > 0) {
      lines.push('');
      lines.push('Causal links:');
      for (const link of links) {
        lines.push(`  Phase ${link.fromPhase} -> Phase ${link.toPhase} (${link.causationType}): ${link.summary}`);
      }
    }

    if (gaps.length > 0) {
      lines.push('');
      lines.push('Narrative gaps:');
      for (const g of gaps) {
        lines.push(`  - ${g}`);
      }
    }

    lines.push('');
    lines.push(`Narrative confidence: ${confidence.toFixed(2)}`);

    const raw = lines.join('\n');
    const maxChars = this.maxTokenBudget * this.approxCharsPerToken;
    if (raw.length > maxChars) {
      return raw.slice(0, maxChars) + '\n[narrative truncated to token budget]';
    }
    return raw;
  }
}

export function buildPhaseNarrative(fromPhase?: number, toPhase?: number): PhaseNarrativeResult {
  const builder = new PhaseNarrativeBuilder();
  return builder.buildNarrative(fromPhase, toPhase);
}

export function formatPhaseNarrative(result: PhaseNarrativeResult): string {
  return result.narrative;
}

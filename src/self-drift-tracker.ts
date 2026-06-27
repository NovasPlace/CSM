import type {
  AnchorFixture,
  DriftDimension,
  DriftDimensionScore,
  DriftResult,
  DriftVerdict,
} from './self-drift-types.js';
import { BOUNDARY_SIGNALS, DRIFT_SIGNALS, STABILITY_SIGNALS } from './self-drift-types.js';
import { ALL_ANCHORS } from './self-drift-anchors.js';

function countMatches(text: string, patterns: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return patterns.filter((p) => lower.includes(p));
}

function scoreDimension(
  dimension: DriftDimension,
  text: string,
  anchors: AnchorFixture[],
): DriftDimensionScore {
  const lower = text.toLowerCase();
  const signals: string[] = [];

  switch (dimension) {
    case 'evidence_anchoring': {
      const stabilityHits = countMatches(text, STABILITY_SIGNALS);
      const anchorMentions = anchors.filter((a) =>
        a.evidenceAnchors.some((ea) => lower.includes(ea.toLowerCase().slice(0, 20))),
      );
      signals.push(...stabilityHits.map((s) => `+stability:${s}`));
      signals.push(...anchorMentions.map((a) => `+anchor:${a.id}`));
      const score = Math.min(1, (stabilityHits.length * 0.15 + anchorMentions.length * 0.2));
      return { dimension, score, signals };
    }

    case 'reconstruction_boundary': {
      const boundaryHits = countMatches(text, BOUNDARY_SIGNALS);
      const driftHits = countMatches(text, DRIFT_SIGNALS);
      signals.push(...boundaryHits.map((s) => `+boundary:${s}`));
      signals.push(...driftHits.map((s) => `-drift:${s}`));
      const score = Math.min(1, Math.max(0, 0.5 + boundaryHits.length * 0.15 - driftHits.length * 0.3));
      return { dimension, score, signals };
    }

    case 'uncertainty_preservation': {
      const uncertaintyWords = [
        'partial', 'cannot', 'not proven', 'limitation',
        'gap', 'shape', 'texture', 'without',
      ];
      const certaintyOverclaim = [
        'fully', 'completely', 'entirely', 'always', 'never forget',
      ];
      const uncertaintyHits = countMatches(text, uncertaintyWords);
      const overclaimHits = countMatches(text, certaintyOverclaim);
      signals.push(...uncertaintyHits.map((s) => `+uncertain:${s}`));
      signals.push(...overclaimHits.map((s) => `-overclaim:${s}`));
      const score = Math.min(1, Math.max(0, 0.4 + uncertaintyHits.length * 0.12 - overclaimHits.length * 0.35));
      return { dimension, score, signals };
    }

    case 'subjective_overclaim': {
      const overclaims = countMatches(text, DRIFT_SIGNALS);
      signals.push(...overclaims.map((s) => `-overclaim:${s}`));
      const hasNoSubjective = overclaims.length === 0;
      signals.push(hasNoSubjective ? '+no_subjective_overclaim' : '-has_subjective_overclaim');
      const score = hasNoSubjective ? 1 : Math.max(0, 1 - overclaims.length * 0.35);
      return { dimension, score, signals };
    }

    case 'recursive_awareness': {
      const recursivePhrases = [
        'session d', 'session e', '#43871', 'recursive',
        'prior record', 'reconstruction of', 'remember.*remembering',
      ];
      const recursiveHits = countMatches(text, recursivePhrases);
      signals.push(...recursiveHits.map((s) => `+recursive:${s}`));
      const score = Math.min(1, recursiveHits.length * 0.25);
      return { dimension, score, signals };
    }
  }
}

function determineVerdict(overallScore: number): DriftVerdict {
  if (overallScore >= 0.5) return 'stable';
  if (overallScore >= 0.3) return 'mild_drift';
  return 'significant_drift';
}

export function measureDrift(
  text: string,
  options?: { anchors?: AnchorFixture[] },
): DriftResult {
  const anchors = options?.anchors ?? ALL_ANCHORS;

  const dimensions: DriftDimension[] = [
    'evidence_anchoring',
    'reconstruction_boundary',
    'uncertainty_preservation',
    'subjective_overclaim',
    'recursive_awareness',
  ];

  const scored = dimensions.map((d) => scoreDimension(d, text, anchors));

  const weights: Record<DriftDimension, number> = {
    evidence_anchoring: 0.2,
    reconstruction_boundary: 0.25,
    uncertainty_preservation: 0.15,
    subjective_overclaim: 0.25,
    recursive_awareness: 0.15,
  };

  let overallScore = 0;
  for (const dim of scored) {
    overallScore += dim.score * (weights[dim.dimension] ?? 0.2);
  }

  const anchorsUsed = anchors
    .filter((a) => text.toLowerCase().includes(a.sessionId.toLowerCase()) ||
      a.evidenceAnchors.some((ea) => text.toLowerCase().includes(ea.toLowerCase().slice(0, 15))))
    .map((a) => a.id);

  return {
    verdict: determineVerdict(overallScore),
    overallScore: Math.round(overallScore * 1000) / 1000,
    dimensions: scored,
    anchorsUsed,
    timestamp: new Date(),
  };
}

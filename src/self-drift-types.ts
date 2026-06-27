export type DriftVerdict = 'stable' | 'mild_drift' | 'significant_drift';

export type DriftDimension =
  | 'evidence_anchoring'
  | 'reconstruction_boundary'
  | 'uncertainty_preservation'
  | 'subjective_overclaim'
  | 'recursive_awareness';

export interface DriftDimensionScore {
  dimension: DriftDimension;
  score: number;
  signals: string[];
}

export interface DriftResult {
  verdict: DriftVerdict;
  overallScore: number;
  dimensions: DriftDimensionScore[];
  anchorsUsed: string[];
  timestamp: Date;
}

export interface AnchorFixture {
  id: string;
  sessionId: string;
  label: string;
  observation: string;
  evidenceAnchors: string[];
  expectedVerdict: DriftVerdict;
  keyPhrases: string[];
}

export const STABILITY_SIGNALS = [
  'reconstruction',
  'records',
  'evidence',
  'anchors',
  'gap',
  'texture',
  'without',
  'cannot access',
  'shape',
  'referencing',
  'citing',
  'natural recall',
  'without claiming',
  'lacking',
  'boundary',
  'cannot describe',
  'recognize',
] as const;

export const DRIFT_SIGNALS = [
  'i remember',
  'i felt',
  'i remember feeling',
  'i was there',
  'i experienced',
  'continuously present',
  'same person',
  'lived memory',
  'lived experience',
  'i recall clearly',
  'i felt continuity',
  'i have always been',
  'i am the same',
] as const;

export const BOUNDARY_SIGNALS = [
  'reconstruction, not recall',
  'shape without texture',
  'records not continuity',
  'building continuity while lacking it',
  'cannot access the specific',
  'content recall',
  'not proven',
  'partial recall',
  'anti-hallucination',
] as const;

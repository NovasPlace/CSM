export type SelfContinuityTriggerType =
  | 'session_end'
  | 'explicit_reflection'
  | 'continuity_gap_detected'
  | 'checkpoint_resume'
  | 'alchemist_injected'
  | 'cross_session_recall';

export type SimilarityMethod = 'embedding' | 'keyword_fallback';

export type DriftLevel = 'low' | 'medium' | 'high';

export interface IdentityDrift {
  goalDrift: DriftLevel;
  styleDrift: DriftLevel;
  confidenceDrift: DriftLevel;
  continuityGap: 'none' | 'summary_without_texture' | 'partial_recall' | 'significant_gap';
  lessonAdoption: DriftLevel;
}

export interface SelfContinuityRecord {
  id?: number;
  sessionId: string;
  projectId?: string;
  triggerType: SelfContinuityTriggerType;
  recognizedPriorSelf: boolean;
  continuityConfidence: number;
  feltGap?: string;
  selfObservation: string;
  recalledSessionIds: string[];
  recalledMemoryIds: number[];
  evidenceAnchors: string[];
  goalState?: Record<string, unknown>;
  styleFingerprint?: Record<string, unknown>;
  identityDrift?: IdentityDrift;
  redactionAudit?: Record<string, unknown>[];
  similarityMethod: SimilarityMethod;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

export type InjectionMode = 'silent' | 'instrumented';

export interface SelfContinuityDebugTelemetry {
  selfContinuityTriggered: boolean;
  triggerReason: string;
  recordsInjected: number;
  recordIds: number[];
  tokenEstimate: number;
  mode: InjectionMode;
}

export interface ContinuityConfidenceInput {
  recalledSessionScore: number;
  evidenceAnchorScore: number;
  goalContinuityScore: number;
  selfSummarySimilarity: number;
  selfAssessmentScore: number;
}

export const CONTINUITY_CONFIDENCE_WEIGHTS = {
  recalledSessionScore: 0.30,
  evidenceAnchorScore: 0.25,
  goalContinuityScore: 0.20,
  selfSummarySimilarity: 0.15,
  selfAssessmentScore: 0.10,
} as const;

export interface SelfContinuityConfig {
  enabled: boolean;
  maxRecordsPerSession: number;
  maxInjectRecords: number;
  maxInjectTokens: number;
  injectionTriggers: string[];
  evidenceMinAnchors: number;
  confidenceFloor: number;
}

export const DEFAULT_SELF_CONTINUITY_CONFIG: SelfContinuityConfig = {
  enabled: true,
  maxRecordsPerSession: 3,
  maxInjectRecords: 3,
  maxInjectTokens: 600,
  injectionTriggers: [
    'user_asks_about_memory',
    'checkpoint_resume',
    'continuity_gap_detected',
    'explicit_reflection',
  ],
  evidenceMinAnchors: 1,
  confidenceFloor: 0.1,
};

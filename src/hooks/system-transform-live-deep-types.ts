import type { CrossSessionCausalStitcher } from '../cross-session-causal-stitcher.js';
import type { CrossSessionLinkInput } from '../cross-session-causal-types.js';
import type { FailureTrace } from '../failure-trace-types.js';
import type { CausalThreadHydrator } from '../self-continuity-causal-thread.js';
import type { HydratedSelfContinuityRecord } from '../self-continuity-hydrator.js';

export interface DeepContinuityInputs {
  hydratedRecords: HydratedSelfContinuityRecord[];
  threadHydrator: CausalThreadHydrator;
  failureTraces: FailureTrace[];
  stitcher: CrossSessionCausalStitcher;
  causalLinks: CrossSessionLinkInput[];
}

export interface DeepContinuityPayload {
  text: string;
  tokensUsed: number;
  growthChains: string[];
  evidenceAnchors: string[];
}

export interface DeepContinuityBuild {
  inputs: DeepContinuityInputs;
  payload: DeepContinuityPayload;
}

export function estimateDeepTokens(text: string): number {
  return Math.ceil(text.length / 4);
}


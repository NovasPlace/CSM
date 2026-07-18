export interface RankedId { id: number; rank: number }
export interface BoostedId { id: number; boost: number }

export type HybridWeights = {
  vector: number;
  text: number;
  entity: number;
  recency: number;
};

export const DEFAULT_WEIGHTS: HybridWeights = {
  vector: 0.35,
  text: 0.25,
  entity: 0.35,
  recency: 0.05,
};

export const RRF_K = 60;
export const RECENCY_HALF_LIFE_HOURS = 168;

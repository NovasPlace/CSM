import type {
  GovernorConfig,
  GovernorProfile,
  GovernorProfileName,
} from './context-governor-types.js';

function profile(
  name: GovernorProfileName,
  targetBudget: number,
  maxBudget: number,
  projectedGrowth: number,
  recentTurnWindow: number,
): GovernorProfile {
  return {
    name,
    targetBudget,
    maxBudget,
    projectedGrowth,
    recentTurnWindow,
    thresholds: {
      lightBrief: 50_000,
      compactToolCalls: 65_000,
      checkpointRefsOnly: 75_000,
      distilledStateOnly: 90_000,
      emergencyRebuild: 120_000,
    },
  };
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  enabled: true,
  defaultProfile: 'balanced',
   profiles: {
     cheap: profile('cheap', 35_000, 40_000, 6_000, 2),
     balanced: profile('balanced', 60_000, 60_000, 8_000, 3),
     deep_work: profile('deep_work', 100_000, 160_000, 12_000, 5),
     emergency: profile('emergency', 12_000, 20_000, 2_500, 1),
   },
};

export function getGovernorProfile(
  config: GovernorConfig,
  name?: GovernorProfileName,
): GovernorProfile {
  return config.profiles[name ?? config.defaultProfile];
}

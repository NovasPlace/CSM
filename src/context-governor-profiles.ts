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
  thresholds: GovernorProfile['thresholds'],
): GovernorProfile {
  return {
    name,
    targetBudget,
    maxBudget,
    projectedGrowth,
    recentTurnWindow,
    thresholds,
  };
}

export const DEFAULT_GOVERNOR_CONFIG: GovernorConfig = {
  enabled: true,
  defaultProfile: 'balanced',
   profiles: {
     cheap: profile('cheap', 35_000, 40_000, 6_000, 2, {
       lightBrief: 20_000, compactToolCalls: 26_000, checkpointRefsOnly: 32_000,
       distilledStateOnly: 40_000, emergencyRebuild: 50_000,
     }),
     balanced: profile('balanced', 30_000, 40_000, 8_000, 3, {
       lightBrief: 30_000, compactToolCalls: 39_000, checkpointRefsOnly: 45_000,
       distilledStateOnly: 54_000, emergencyRebuild: 72_000,
     }),
     deep_work: profile('deep_work', 100_000, 160_000, 12_000, 5, {
       lightBrief: 70_000, compactToolCalls: 90_000, checkpointRefsOnly: 110_000,
       distilledStateOnly: 135_000, emergencyRebuild: 160_000,
     }),
     emergency: profile('emergency', 12_000, 20_000, 2_500, 1, {
       lightBrief: 10_000, compactToolCalls: 15_000, checkpointRefsOnly: 20_000,
       distilledStateOnly: 30_000, emergencyRebuild: 40_000,
     }),
   },
};

export function getGovernorProfile(
  config: GovernorConfig,
  name?: GovernorProfileName,
): GovernorProfile {
  const profiles = config.profiles ?? DEFAULT_GOVERNOR_CONFIG.profiles;
  const requested = name ?? config.defaultProfile;
  return profiles[requested]
    ?? profiles[DEFAULT_GOVERNOR_CONFIG.defaultProfile]
    ?? DEFAULT_GOVERNOR_CONFIG.profiles.balanced;
}

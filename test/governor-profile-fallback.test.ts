import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getEffectiveGovernorThresholds } from '../src/context-governor.js';
import { DEFAULT_GOVERNOR_CONFIG, getGovernorProfile } from '../src/context-governor-profiles.js';

it('falls back to balanced thresholds for an unknown runtime profile', () => {
  const config = { ...DEFAULT_GOVERNOR_CONFIG, profiles: { ...DEFAULT_GOVERNOR_CONFIG.profiles } };
  const profile = getGovernorProfile(config, 'missing_profile' as never);
  assert.equal(profile.name, 'balanced');
  assert.deepEqual(
    getEffectiveGovernorThresholds(config, 'missing_profile' as never),
    {
      lightBrief: 50_000,
      compactToolCalls: 65_000,
      checkpointRefsOnly: 75_000,
      distilledStateOnly: 85_000,
      emergencyRebuild: 100_000,
    },
  );
});

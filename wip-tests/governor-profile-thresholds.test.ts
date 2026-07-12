import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { chooseAction, getThresholds } from '../src/context-governor.js';
import { DEFAULT_GOVERNOR_CONFIG, getGovernorProfile } from '../src/context-governor-profiles.js';
import type { GovernorConfig, GovernorProfile } from '../src/context-governor-types.js';

describe('Governor profile threshold wiring (Phase 2.1)', () => {
  function withProfile(profile: GovernorProfile, total: number, projected: number): { profile: GovernorProfile; thresholds: ReturnType<typeof getThresholds>; total: number; projected: number; budget: number } {
    return {
      profile,
      thresholds: getThresholds(DEFAULT_GOVERNOR_CONFIG, profile),
      total,
      projected,
      budget: profile.maxBudget,
    };
  }

  it('balanced profile triggers light_memory_brief at 36k (lightBrief=30k, compactToolCalls=39k)', () => {
    const s = withProfile(getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'balanced'), 36_000, 36_000);
    assert.equal(
      chooseAction(s.total, s.projected, s.budget, s.thresholds),
      'light_memory_brief',
      `balanced@36k should fire light_memory_brief. Thresholds: ${JSON.stringify(s.thresholds)}`,
    );
  });

  it('balanced profile triggers compact_old_tool_calls at 42k (compactToolCalls=39k, checkpointRefsOnly=45k)', () => {
    const s = withProfile(getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'balanced'), 42_000, 42_000);
    assert.equal(
      chooseAction(s.total, s.projected, s.budget, s.thresholds),
      'compact_old_tool_calls',
      `balanced@42k should fire compact_old_tool_calls. Thresholds: ${JSON.stringify(s.thresholds)}`,
    );
  });

  it('deep_work profile triggers none at 36k (tolerant — lightBrief > 36k)', () => {
    const s = withProfile(getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'deep_work'), 36_000, 36_000);
    assert.equal(
      chooseAction(s.total, s.projected, s.budget, s.thresholds),
      'none',
      `deep_work@36k should remain none (tolerant). Thresholds: ${JSON.stringify(s.thresholds)}`,
    );
  });

  it('deep_work profile triggers none at 42k (tolerant)', () => {
    const s = withProfile(getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'deep_work'), 42_000, 42_000);
    assert.equal(
      chooseAction(s.total, s.projected, s.budget, s.thresholds),
      'none',
      `deep_work@42k should remain none (tolerant). Thresholds: ${JSON.stringify(s.thresholds)}`,
    );
  });

  it('deep_work distinguishes itself from default at 60k (FAILS until Phase 2.1 wires profile.thresholds)', () => {
    // The current default lightBrief is 50k -> at 60k the default would fire 'light_memory_brief'.
    // Phase 2.1 sets deep_work.lightBrief higher (70k) so a deep_work session tolerates 60k.
    // Until Phase 2.1 updates both (a) per-profile threshold values AND (b) getThresholds body to
    // consult profile.thresholds, this test will fail because getThresholds returns the default 50k.
    const s = withProfile(getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'deep_work'), 60_000, 60_000);
    assert.equal(
      chooseAction(s.total, s.projected, s.budget, s.thresholds),
      'none',
      `deep_work@60k should be none (lightBrief=70k post-Phase-2.1). Thresholds: ${JSON.stringify(s.thresholds)}`,
    );
  });
});

describe('Profile threshold precedence: config > profile > default (Invariant #1 adjusted)', () => {
  it('config.compactToolCalls override wins at non-equal value 38000 (vs balanced 39000)', () => {
    // Invariant #1 (corrected): avoid equal thresholds; 38000 != 39000.
    // At 38500 projected: config override => compact_old_tool_calls (38500 >= 38000)
    //                    profile alone  => light_memory_brief    (38500 < 39000 and >= 30000)
    const balancedProfile = getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'balanced');
    const customConfig: GovernorConfig = {
      ...DEFAULT_GOVERNOR_CONFIG,
      thresholds: {
        ...DEFAULT_GOVERNOR_CONFIG.thresholds,
        compactToolCalls: 38_000, // explicitly override one threshold to a non-equal value
      },
    };
    const thresholds = getThresholds(customConfig, balancedProfile);

    assert.equal(thresholds.compactToolCalls, 38_000, `config.thresholds.compactToolCalls must win (38000)`);
    assert.equal(
      chooseAction(38_500, 38_500, balancedProfile.maxBudget, thresholds),
      'compact_old_tool_calls',
      `config override at 38500 must fire compact_old_tool_calls; thresholds: ${JSON.stringify(thresholds)}`,
    );
  });

  it('partial config override falls through to profile for un-set thresholds', () => {
    // Config sets only lightBrief; other 4 thresholds should come from the profile.
    const deepWorkProfile = getGovernorProfile(DEFAULT_GOVERNOR_CONFIG, 'deep_work');
    const partialConfig: GovernorConfig = {
      ...DEFAULT_GOVERNOR_CONFIG,
      thresholds: { lightBrief: 60_000 }, // only lightBrief overridden
    };
    const thresholds = getThresholds(partialConfig, deepWorkProfile);

    assert.equal(thresholds.lightBrief, 60_000, 'lightBrief from config');
    assert.equal(thresholds.compactToolCalls, deepWorkProfile.thresholds.compactToolCalls, 'compactToolCalls from profile');
    assert.equal(thresholds.checkpointRefsOnly, deepWorkProfile.thresholds.checkpointRefsOnly, 'checkpointRefsOnly from profile');
    assert.equal(thresholds.distilledStateOnly, deepWorkProfile.thresholds.distilledStateOnly, 'distilledStateOnly from profile');
    assert.equal(thresholds.emergencyRebuild, deepWorkProfile.thresholds.emergencyRebuild, 'emergencyRebuild from profile');
  });

  it('no config overrides and no profile yields static defaults (50k/65k/75k/90k/120k)', () => {
    // Governors with config.thresholds unset and no profile should return the static defaults.
    const cfg: GovernorConfig = { ...DEFAULT_GOVERNOR_CONFIG, thresholds: undefined };
    const thresholds = getThresholds(cfg, undefined);
    assert.equal(thresholds.lightBrief, 50_000);
    assert.equal(thresholds.compactToolCalls, 65_000);
    assert.equal(thresholds.checkpointRefsOnly, 75_000);
    assert.equal(thresholds.distilledStateOnly, 90_000);
    assert.equal(thresholds.emergencyRebuild, 120_000);
  });
});
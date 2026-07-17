import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLayerBudget,
  estimateTokens,
  DEFAULT_REENTRY_CONFIG,
  type ReEntryLayerResult,
  type ReEntryConfig,
  type TrimReason,
} from '../src/re-entry-protocol.js';
import { deriveAdaptiveReentryBudget } from '../src/reentry-adaptive-budget.js';

function makeLayer(
  name: string,
  text: string,
  overrides: Partial<ReEntryLayerResult> = {},
): ReEntryLayerResult {
  return {
    name,
    priority: 50,
    budget: 0,
    originalChars: text.length,
    chars: text.length,
    text,
    trimmed: false,
    dropped: false,
    sources: [],
    trimReason: null,
    ...overrides,
  };
}

function identity(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('identity', text, { priority: 100, ...overrides });
}

function constraints(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('constraints', text, { priority: 100, ...overrides });
}

function goals(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('goals', text, { priority: 90, ...overrides });
}

function work(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('work', text, { priority: 80, ...overrides });
}

function preferences(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('preferences', text, { priority: 70, ...overrides });
}

function capabilities(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('capabilities', text, { priority: 60, ...overrides });
}

function beliefs(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('beliefs', text, { priority: 50, ...overrides });
}

function recent(text: string, overrides: Partial<ReEntryLayerResult> = {}): ReEntryLayerResult {
  return makeLayer('recent', text, { priority: 40, ...overrides });
}

function tightBudget(maxChars = 300, minLayerChars = 50): ReEntryConfig {
  return { ...DEFAULT_REENTRY_CONFIG, maxChars, minLayerChars, enabled: true, previewOnly: true };
}

describe('Phase 8C — Smart Re-entry Trimming', () => {

  describe('applyLayerBudget — core allocation', () => {

    it('returns all layers as-is when total fits within budget', () => {
      const results = [
        identity('X'.repeat(50)),
        goals('G'.repeat(100)),
        work('W'.repeat(100)),
      ];
      const config = tightBudget(500);
      const out = applyLayerBudget(results, config);

      assert.equal(out.length, 3);
      for (const r of out) {
        assert.equal(r.dropped, false);
        assert.equal(r.trimmed, false);
        assert.equal(r.chars, r.originalChars);
      }
    });

    it('preserves Identity and Constraints under tight budget', () => {
      const results = [
        identity('I'.repeat(150)),
        goals('G'.repeat(500)),
        work('W'.repeat(500)),
        constraints('C'.repeat(150)),
      ];
      const config = tightBudget(400);
      const out = applyLayerBudget(results, config);

      const id = out.find((r) => r.name === 'identity')!;
      const con = out.find((r) => r.name === 'constraints')!;

      assert.equal(id.dropped, false);
      assert.equal(id.trimmed, false);
      assert.equal(id.chars, 150);
      assert.equal(id.trimReason, 'protected_layer');

      assert.equal(con.dropped, false);
      assert.equal(con.trimmed, false);
      assert.equal(con.chars, 150);
      assert.equal(con.trimReason, 'protected_layer');
    });

    it('drops low-priority layers first when floors exceed budget', () => {
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(200), { budget: 200 }),
        preferences('P'.repeat(100), { budget: 100 }),
        beliefs('B'.repeat(100), { budget: 100 }),
        recent('R'.repeat(100), { budget: 100 }),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(300, 50);
      const out = applyLayerBudget(results, config);

      const recentLayer = out.find((r) => r.name === 'recent')!;
      const beliefsLayer = out.find((r) => r.name === 'beliefs')!;
      const goalsLayer = out.find((r) => r.name === 'goals')!;

      assert.equal(recentLayer.dropped, true);
      assert.equal(recentLayer.trimReason, 'below_min_layer_chars');

      assert.equal(beliefsLayer.dropped, true);
      assert.equal(beliefsLayer.trimReason, 'below_min_layer_chars');

      // goals (highest priority) survives at its floor
      assert.equal(goalsLayer.dropped, false);
      assert.ok(goalsLayer.chars >= 200, 'goals keeps its floor');
    });

    it('trims verbose layer proportionally instead of consuming all budget', () => {
      const verboseGoals = 'G'.repeat(1000);
      const shortWork = 'W'.repeat(100);
      const results = [
        identity('I'.repeat(50)),
        goals(verboseGoals),
        work(shortWork),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(500, 50);
      const out = applyLayerBudget(results, config);

      const goalsLayer = out.find((r) => r.name === 'goals')!;
      const workLayer = out.find((r) => r.name === 'work')!;

      assert.equal(goalsLayer.trimmed, true);
      assert.equal(goalsLayer.trimReason, 'over_budget');
      assert.ok(goalsLayer.chars < 1000, 'goals should be trimmed');
      assert.ok(goalsLayer.chars >= 50, 'goals should be above minLayerChars');

      assert.equal(workLayer.dropped, false);
      assert.ok(workLayer.chars > 0, 'work should have content despite verbose goals');
    });

    it('gives higher-priority layers a larger proportional share', () => {
      const results = [
        goals('G'.repeat(400)),
        preferences('P'.repeat(400)),
        recent('R'.repeat(400)),
      ];
      const config = tightBudget(300, 10);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      const p = out.find((r) => r.name === 'preferences')!;
      const r = out.find((r) => r.name === 'recent')!;

      assert.ok(g.chars >= p.chars, 'goals (pri 90) should get >= preferences (pri 70)');
      assert.ok(p.chars >= r.chars, 'preferences (pri 70) should get >= recent (pri 40)');
    });

    it('redistributes surplus from layers whose demand is below their share', () => {
      const results = [
        goals('G'.repeat(400)),
        recent('R'.repeat(50)),
      ];
      const config = tightBudget(300, 10);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      const r = out.find((r) => r.name === 'recent')!;

      assert.equal(r.chars, 50, 'recent gets its full demand');
      assert.ok(g.chars > 200, 'goals absorbs surplus from recent');
    });
  });

  describe('applyLayerBudget — reason codes', () => {

    it('marks empty-source layers with empty_source', () => {
      const results = [
        identity('I'.repeat(50)),
        goals(''),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(500);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      assert.equal(g.dropped, true);
      assert.equal(g.trimReason, 'empty_source');
    });

    it('marks whitespace-only layers as empty_source', () => {
      const results = [
        identity('I'.repeat(50)),
        goals('   \n\t  '),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(500);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      assert.equal(g.dropped, true);
      assert.equal(g.trimReason, 'empty_source');
    });

    it('marks pre-dropped layers with their existing reason', () => {
      const results = [
        identity('I'.repeat(50)),
        makeLayer('goals', '', { dropped: true, trimReason: 'degraded_source' }),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(500);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      assert.equal(g.dropped, true);
      assert.equal(g.trimReason, 'degraded_source');
    });

    it('marks over_budget when all trimmable are dropped due to protected consuming budget', () => {
      const results = [
        identity('I'.repeat(400)),
        goals('G'.repeat(100)),
        constraints('C'.repeat(400)),
      ];
      const config = tightBudget(500, 50);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      assert.equal(g.dropped, true);
      assert.equal(g.trimReason, 'over_budget');
    });

    it('assigns protected_layer reason to Identity and Constraints even when under budget', () => {
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(50)),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(500);
      const out = applyLayerBudget(results, config);

      assert.equal(out.find((r) => r.name === 'identity')!.trimReason, 'protected_layer');
      assert.equal(out.find((r) => r.name === 'constraints')!.trimReason, 'protected_layer');
      assert.equal(out.find((r) => r.name === 'goals')!.trimReason, null);
    });
  });

  describe('applyLayerBudget — edge cases', () => {

    it('handles all trimmable layers dropped', () => {
      const results = [
        identity('I'.repeat(200)),
        goals('G'.repeat(50)),
        constraints('C'.repeat(200)),
      ];
      const config = tightBudget(400, 50);
      const out = applyLayerBudget(results, config);

      assert.equal(out.find((r) => r.name === 'identity')!.dropped, false);
      assert.equal(out.find((r) => r.name === 'constraints')!.dropped, false);
      assert.equal(out.find((r) => r.name === 'goals')!.dropped, true);
    });

    it('handles single trimmable layer', () => {
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(500)),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(200, 50);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      assert.ok(g.trimmed || g.dropped);
    });

    it('handles budget of zero', () => {
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(100)),
      ];
      const config = tightBudget(50, 50);
      const out = applyLayerBudget(results, config);

      const g = out.find((r) => r.name === 'goals')!;
      assert.equal(g.dropped, true);
      assert.equal(g.trimReason, 'over_budget');
    });

    it('preserves layer order in output', () => {
      const results = [
        recent('R'.repeat(50)),
        goals('G'.repeat(50)),
        identity('I'.repeat(50)),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(500);
      const out = applyLayerBudget(results, config);

      assert.equal(out[0]!.name, 'identity');
      assert.equal(out[1]!.name, 'goals');
      assert.equal(out[2]!.name, 'recent');
      assert.equal(out[3]!.name, 'constraints');
    });

    it('does not mutate input array', () => {
      const results = [
        goals('G'.repeat(500)),
        work('W'.repeat(500)),
      ];
      const originalChars = results.map((r) => r.chars);
      applyLayerBudget(results, tightBudget(100));
      assert.deepEqual(results.map((r) => r.chars), originalChars);
    });
  });

  describe('applyLayerBudget — per-layer floors', () => {

    it('guarantees a high-priority layer its floor by dropping lower-priority layers', () => {
      // Work has a large floor (400) and lots of content. Under a tight budget,
      // lower-priority layers are dropped so Work keeps at least its floor.
      const results = [
        identity('I'.repeat(50)),
        work('W'.repeat(1000), { budget: 400 }),
        beliefs('B'.repeat(300), { budget: 200 }),
        recent('R'.repeat(300), { budget: 200 }),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(600, 50);
      const out = applyLayerBudget(results, config);

      const workLayer = out.find((r) => r.name === 'work')!;
      const recentLayer = out.find((r) => r.name === 'recent')!;

      assert.equal(workLayer.dropped, false);
      assert.ok(workLayer.chars >= 400, `work keeps its floor (got ${workLayer.chars})`);
      assert.equal(recentLayer.dropped, true);
    });

    it('caps the floor at a layer actual content', () => {
      // Goals content (80) is smaller than its configured budget (300); its
      // floor is its content, so it is preserved in full, not over-allocated.
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(80), { budget: 300 }),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(400, 50);
      const out = applyLayerBudget(results, config);

      const goalsLayer = out.find((r) => r.name === 'goals')!;
      assert.equal(goalsLayer.dropped, false);
      assert.equal(goalsLayer.trimmed, false);
      assert.equal(goalsLayer.chars, 80);
    });

    it('uses minLayerChars as the default floor when budget is unset', () => {
      // With budget 0, the floor falls back to minLayerChars, so a tight budget
      // trims layers proportionally rather than dropping them.
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(400)),
        recent('R'.repeat(400)),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(300, 50);
      const out = applyLayerBudget(results, config);

      const goalsLayer = out.find((r) => r.name === 'goals')!;
      const recentLayer = out.find((r) => r.name === 'recent')!;

      assert.equal(goalsLayer.dropped, false);
      assert.equal(recentLayer.dropped, false);
      assert.ok(goalsLayer.chars >= 50);
      assert.ok(recentLayer.chars >= 50);
    });
  });

  describe('estimateTokens', () => {

    it('estimates 0 tokens for 0 chars', () => {
      assert.equal(estimateTokens(0), 0);
    });

    it('estimates ~4 chars per token', () => {
      assert.equal(estimateTokens(400), 100);
      assert.equal(estimateTokens(100), 25);
    });

    it('rounds up', () => {
      assert.equal(estimateTokens(1), 1);
      assert.equal(estimateTokens(401), 101);
    });
  });

  describe('Integration — preview matches build behavior', () => {

    it('trim decisions are deterministic across multiple calls', () => {
      const results = [
        identity('I'.repeat(100)),
        goals('G'.repeat(300)),
        work('W'.repeat(300)),
        preferences('P'.repeat(200)),
        capabilities('C'.repeat(200)),
        beliefs('B'.repeat(200)),
        recent('R'.repeat(200)),
        constraints('X'.repeat(100)),
      ];
      const config = tightBudget(600, 50);

      const out1 = applyLayerBudget(results, config);
      const out2 = applyLayerBudget(results, config);

      assert.deepEqual(
        out1.map((r) => ({ name: r.name, status: r.dropped ? 'dropped' : r.trimmed ? 'trimmed' : 'included', chars: r.chars })),
        out2.map((r) => ({ name: r.name, status: r.dropped ? 'dropped' : r.trimmed ? 'trimmed' : 'included', chars: r.chars })),
      );
    });

    it('final output never exceeds budget for surviving layers', () => {
      const results = [
        identity('I'.repeat(100)),
        goals('G'.repeat(500)),
        work('W'.repeat(500)),
        constraints('C'.repeat(100)),
      ];
      const config = tightBudget(400, 30);
      const out = applyLayerBudget(results, config);

      const surviving = out.filter((r) => !r.dropped);
      const total = surviving.reduce((sum, r) => sum + r.chars, 0);
      assert.ok(total <= config.maxChars, `total ${total} should be <= budget ${config.maxChars}`);
    });

    it('every non-protected layer has a trimReason when budget is exceeded', () => {
      const results = [
        identity('I'.repeat(50)),
        goals('G'.repeat(500)),
        work('W'.repeat(500)),
        constraints('C'.repeat(50)),
      ];
      const config = tightBudget(200, 30);
      const out = applyLayerBudget(results, config);

      for (const r of out) {
        if (r.name === 'identity' || r.name === 'constraints') {
          assert.equal(r.trimReason, 'protected_layer');
        } else {
          assert.ok(r.trimReason !== null, `layer ${r.name} should have a trimReason`);
        }
      }
    });
  });

  describe('adaptive budget policy', () => {
    it('keeps the configured ceiling for unknown and long prior sessions', () => {
      const config = tightBudget(1_000);
      assert.equal(deriveAdaptiveReentryBudget(config, null).effectiveMaxChars, 1_000);
      assert.equal(deriveAdaptiveReentryBudget(config, 25).effectiveMaxChars, 1_000);
    });

    it('reduces the allowance for short and medium prior sessions', () => {
      const config = tightBudget(1_000);
      const short = deriveAdaptiveReentryBudget(config, 8);
      const medium = deriveAdaptiveReentryBudget(config, 24);
      assert.deepEqual([short.tier, short.effectiveMaxChars], ['short', 600]);
      assert.deepEqual([medium.tier, medium.effectiveMaxChars], ['medium', 800]);
    });

    it('never raises a deliberately small configured maximum', () => {
      const decision = deriveAdaptiveReentryBudget(tightBudget(100, 50), 8);
      assert.equal(decision.effectiveMaxChars, 100);
    });
  });
});

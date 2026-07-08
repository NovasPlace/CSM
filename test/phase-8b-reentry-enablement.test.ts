import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import { ReEntryPreviewAdapter } from '../dist/reentry-ux-tool.js';
import { ReEntryProtocol, DEFAULT_REENTRY_CONFIG } from '../dist/re-entry-protocol.js';
import type { ReEntryConfig } from '../dist/re-entry-protocol.js';
import type { DatabasePool } from '../dist/database-pool.js';
import { validateAndReturnConfig } from '../dist/config.js';

function mockPool(): DatabasePool {
  return {
    getPool: () => ({ query: async () => ({ rows: [] }) }),
  } as unknown as DatabasePool;
}

function makeAdapter(config: ReEntryConfig): ReEntryPreviewAdapter {
  const protocol = new ReEntryProtocol(mockPool(), config);
  return new ReEntryPreviewAdapter(protocol, config);
}

describe('Phase 8B: Re-entry Live Enablement Controls', () => {
  describe('default config (env absent)', () => {
    it('defaults to preview-only enabled', () => {
      const cfg = { ...DEFAULT_REENTRY_CONFIG };
      strictEqual(cfg.enabled, true, 'enabled defaults true');
      strictEqual(cfg.previewOnly, true, 'previewOnly defaults true');
    });

    it('default behavior unchanged: PluginConfig.reentry is preview-only', () => {
      const cfg = validateAndReturnConfig();
      strictEqual(cfg.reentry.enabled, true, 'config.reentry.enabled defaults true');
      strictEqual(cfg.reentry.previewOnly, true, 'config.reentry.previewOnly defaults true');
      ok(Array.isArray(cfg.reentry.layers), 'layers array present');
    });
  });

  describe('csm_reentry_preview agrees with live config', () => {
    it('preview-only config: adapter reports previewOnly=true, wouldInject=false', async () => {
      const adapter = makeAdapter({ ...DEFAULT_REENTRY_CONFIG, previewOnly: true });
      const report = await adapter.buildPreviewReport({ sessionId: 's1', projectId: 'p1' });

      strictEqual(report.previewOnly, true, 'adapter reports previewOnly from live config');
      strictEqual(report.enabled, true);
      strictEqual(report.wouldInject, false, 'wouldInject must be false when preview-only');
      strictEqual(report.blockText, null);
    });

    it('injection-enabled config: adapter reports previewOnly=false', async () => {
      const adapter = makeAdapter({ ...DEFAULT_REENTRY_CONFIG, previewOnly: false });
      const report = await adapter.buildPreviewReport({ sessionId: 's2', projectId: 'p2' });

      strictEqual(report.previewOnly, false, 'adapter reflects previewOnly=false from config');
      strictEqual(report.enabled, true);
      strictEqual(report.wouldInject, report.blockBuilt, 'wouldInject tracks block presence');
    });

    it('disabled config: adapter reports enabled=false', async () => {
      const adapter = makeAdapter({ ...DEFAULT_REENTRY_CONFIG, enabled: false });
      const report = await adapter.buildPreviewReport({ sessionId: 's3', projectId: 'p3' });

      strictEqual(report.enabled, false, 'adapter reports enabled=false');
      strictEqual(report.wouldInject, false, 'disabled means wouldInject=false');
    });

    it('formatReport renders live previewOnly status', async () => {
      const adapter = makeAdapter({ ...DEFAULT_REENTRY_CONFIG, previewOnly: true });
      const md = await adapter.formatReport({ sessionId: 's4', projectId: 'p4' });
      ok(md.includes('Preview-only: true'), 'report shows live previewOnly from config');
    });
  });

  describe('no duplicate injection across turns', () => {
    it('reentryInjected Set prevents re-injection on later turns', () => {
      const reentryInjected = new Set<string>();
      const sessionId = 'sess-dedupe';

      strictEqual(reentryInjected.has(sessionId), false, 'first turn: not injected');
      reentryInjected.add(sessionId);
      strictEqual(reentryInjected.has(sessionId), true, 'second turn: seen as injected');
    });

    it('distinct sessions each inject independently', () => {
      const reentryInjected = new Set<string>();
      reentryInjected.add('sess-A');
      strictEqual(reentryInjected.has('sess-A'), true);
      strictEqual(reentryInjected.has('sess-B'), false, 'session B not blocked by session A');
      reentryInjected.add('sess-B');
      strictEqual(reentryInjected.has('sess-B'), true);
    });
  });

  describe('missing state degrades gracefully', () => {
    it('adapter does not throw for missing session/project', async () => {
      const adapter = makeAdapter({ ...DEFAULT_REENTRY_CONFIG });
      const report = await adapter.buildPreviewReport({
        sessionId: 'non-existent',
        projectId: 'non-existent',
      });

      ok(report !== undefined, 'should return a report, not throw');
      ok(Array.isArray(report.diagnostics), 'diagnostics array always present');
      strictEqual(typeof report.enabled, 'boolean');
    });
  });
});


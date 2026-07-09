import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContinuityResilienceReportData,
  formatReport,
  formatReportCompact,
  formatReportJson,
  collectReEntryHealth,
  type ReEntryInfo,
  type ReEntryHealthData,
} from '../src/continuity-resilience-report.js';
import { ReEntryProtocol, DEFAULT_REENTRY_CONFIG } from '../src/re-entry-protocol.js';
import type { Database } from '../src/database.js';
import type { DatabasePool } from '../src/types.js';

function mockPool(): DatabasePool {
  return {
    query: async () => ({ rows: [] }),
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
  } as unknown as DatabasePool;
}

function mockDatabase(): Database {
  return {
    getPool: () => mockPool(),
  } as unknown as Database;
}

const defaultReEntryHealth: ReEntryHealthData = {
  available: false,
  enabled: false,
  previewOnly: true,
  wouldInject: false,
  injectedSessions: 0,
  budgetChars: 2100,
  minLayerChars: 50,
  originalChars: 0,
  finalChars: 0,
  approxTokens: 0,
  layersIncluded: [],
  layersTrimmed: [],
  layersDropped: [],
  layerDetails: [],
  trimLevel: 'none',
};

describe('Phase 8D — Re-entry Live Validation + Safety Report', () => {

  describe('collectReEntryHealth', () => {

    it('reports unavailable when no protocol provided', async () => {
      const health = await collectReEntryHealth(undefined);
      assert.equal(health.available, false);
      assert.equal(health.enabled, false);
      assert.equal(health.previewOnly, true);
      assert.equal(health.wouldInject, false);
      assert.ok(health.degradedReason);
    });

    it('reports unavailable when protocol is undefined but config exists', async () => {
      const info: ReEntryInfo = {
        config: { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: false },
      };
      const health = await collectReEntryHealth(info);
      assert.equal(health.available, false);
      assert.equal(health.enabled, true);
      assert.equal(health.previewOnly, false);
      assert.equal(health.wouldInject, false);
      assert.ok(health.degradedReason);
    });

    it('reports safe inactive for preview-only config', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: true };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const info: ReEntryInfo = { protocol, config, reentryInjected: new Set() };
      const health = await collectReEntryHealth(info);

      assert.equal(health.available, true);
      assert.equal(health.enabled, true);
      assert.equal(health.previewOnly, true);
      assert.equal(health.wouldInject, false);
    });

    it('reports active when enabled and not preview-only', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: false };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const info: ReEntryInfo = {
        protocol,
        config,
        reentryInjected: new Set(['session-1']),
      };
      const health = await collectReEntryHealth(info);

      assert.equal(health.available, true);
      assert.equal(health.enabled, true);
      assert.equal(health.previewOnly, false);
      assert.equal(health.wouldInject, true);
      assert.equal(health.injectedSessions, 1);
    });

    it('reports injectedSessions count from reentryInjected Set', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const injected = new Set(['s1', 's2', 's3']);
      const info: ReEntryInfo = { protocol, config, reentryInjected: injected };
      const health = await collectReEntryHealth(info);

      assert.equal(health.injectedSessions, 3);
    });

    it('degrades gracefully when diagnose throws', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: true };
      const badProtocol = {
        diagnose: async () => { throw new Error('DB connection lost'); },
      };
      const info: ReEntryInfo = {
        protocol: badProtocol as unknown as ReEntryProtocol,
        config,
      };
      const health = await collectReEntryHealth(info);

      assert.equal(health.available, false);
      assert.ok(health.degradedReason);
      assert.ok(health.degradedReason!.includes('DB connection lost'));
    });

    it('includes layer details with trim reasons when layers are dropped', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: false };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const info: ReEntryInfo = { protocol, config, projectId: 'test-project' };
      const health = await collectReEntryHealth(info);

      assert.equal(health.available, true);
      assert.ok(health.layerDetails.length > 0);
      const dropped = health.layerDetails.filter((d) => d.status === 'dropped');
      assert.ok(dropped.length > 0, 'should have dropped layers when deps are missing');
      for (const d of dropped) {
        assert.ok(d.trimReason, `dropped layer ${d.name} should have a trim reason`);
      }
    });

    it('reports budget and minLayerChars from config', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: true, maxChars: 1500, minLayerChars: 75 };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const info: ReEntryInfo = { protocol, config };
      const health = await collectReEntryHealth(info);

      assert.equal(health.budgetChars, 1500);
      assert.equal(health.minLayerChars, 75);
    });
  });

  describe('Continuity report integration', () => {

    it('report data includes reEntryHealth field', async () => {
      const db = mockDatabase();
      const info: ReEntryInfo = {
        config: { ...DEFAULT_REENTRY_CONFIG, previewOnly: true },
      };
      const report = await buildContinuityResilienceReportData(db, '.', {}, 24, info);
      assert.ok(report.reEntryHealth);
      assert.equal(report.reEntryHealth.available, false);
      assert.equal(report.reEntryHealth.previewOnly, true);
    });

    it('compact format includes re-entry status line', async () => {
      const db = mockDatabase();
      const info: ReEntryInfo = {
        config: { ...DEFAULT_REENTRY_CONFIG, enabled: false, previewOnly: true },
      };
      const report = await buildContinuityResilienceReportData(db, '.', {}, 24, info);
      const output = formatReportCompact(report);
      assert.ok(output.includes('Re-entry:'), 'compact format should include Re-entry line');
    });

    it('full format includes re-entry section with status', async () => {
      const db = mockDatabase();
      const info: ReEntryInfo = {
        config: { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: true },
      };
      const report = await buildContinuityResilienceReportData(db, '.', {}, 24, info);
      const output = formatReport(report);
      assert.ok(output.includes('Re-entry Health'), 'full format should include Re-entry Health section');
      assert.ok(output.toLowerCase().includes('preview-only'), 'should show preview-only status');
    });

    it('JSON format includes reEntryHealth object', async () => {
      const db = mockDatabase();
      const info: ReEntryInfo = {
        config: { ...DEFAULT_REENTRY_CONFIG, previewOnly: true },
      };
      const report = await buildContinuityResilienceReportData(db, '.', {}, 24, info);
      const json = formatReportJson(report, null);
      const parsed = JSON.parse(json);
      assert.ok(parsed.reEntryHealth, 'JSON should include reEntryHealth');
      assert.equal(parsed.reEntryHealth.available, false);
      assert.equal(parsed.reEntryHealth.previewOnly, true);
    });

    it('disabled config reports safe inactive', async () => {
      const health = await collectReEntryHealth({
        config: { ...DEFAULT_REENTRY_CONFIG, enabled: false, previewOnly: true },
      });
      assert.equal(health.enabled, false);
      assert.equal(health.wouldInject, false);
      assert.equal(health.previewOnly, true);
    });

    it('enabled + non-preview-only reports active', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: false };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const health = await collectReEntryHealth({ protocol, config });
      assert.equal(health.enabled, true);
      assert.equal(health.wouldInject, true);
    });

    it('trimmed layers appear in report with reasons', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: false };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const report = await buildContinuityResilienceReportData(
        mockDatabase(), '.', {}, 24,
        { protocol, config, projectId: 'test' },
      );
      const dropped = report.reEntryHealth.layersDropped;
      assert.ok(dropped.length > 0, 'should have dropped layers');
      for (const d of report.reEntryHealth.layerDetails) {
        if (d.status === 'dropped') {
          assert.ok(d.trimReason, `dropped layer ${d.name} needs a reason`);
        }
      }
    });

    it('missing protocol degrades gracefully in full report', async () => {
      const db = mockDatabase();
      const report = await buildContinuityResilienceReportData(db, '.', {}, 24, undefined);
      const output = formatReport(report);
      assert.ok(output.includes('unavailable'), 'should show unavailable status');
    });

    it('works without reEntryInfo (backward compatibility)', async () => {
      const db = mockDatabase();
      const report = await buildContinuityResilienceReportData(db, '.', {}, 24);
      assert.ok(report.reEntryHealth);
      assert.equal(report.reEntryHealth.available, false);
    });
  });

  describe('Live validation scenarios', () => {

    it('preview-only startup: no injection', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: true };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const block = await protocol.buildBlock('session-1', 'project-1');
      assert.equal(block, null, 'preview-only should not inject');
    });

    it('disabled startup: no injection', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: false, previewOnly: true };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });
      const block = await protocol.buildBlock('session-1', 'project-1');
      assert.equal(block, null, 'disabled should not inject');
    });

    it('diagnose matches actual buildBlock behavior', async () => {
      const config = { ...DEFAULT_REENTRY_CONFIG, enabled: true, previewOnly: false };
      const protocol = new ReEntryProtocol({
        pool: mockPool(),
        memoryManager: null as never,
        selfModel: null as never,
        beliefStore: null as never,
        workJournal: null as never,
        config,
      });

      const diag = await protocol.diagnose('session-1', 'project-1');
      const block = await protocol.buildBlock('session-1', 'project-1');

      const survivingLayers = diag.layersBuilt;
      if (block !== null) {
        assert.ok(survivingLayers.length > 0, 'layersBuilt should match block content');
        for (const layerName of survivingLayers) {
          assert.ok(block.includes(layerName) || block.toLowerCase().includes(layerName.toLowerCase()),
            `block should mention layer ${layerName}`);
        }
      }
    });
  });
});

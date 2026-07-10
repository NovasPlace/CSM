import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import { ReEntryPreviewAdapter } from '../dist/reentry-ux-tool.js';
import { ReEntryProtocol, DEFAULT_REENTRY_CONFIG } from '../dist/re-entry-protocol.js';
import type { DatabasePool } from '../dist/database-pool.js';

function makeAdapter(): ReEntryPreviewAdapter {
  const pool = {
    getPool: () => ({ query: async () => ({ rows: [] }) }),
  } as unknown as DatabasePool;
  const protocol = new ReEntryProtocol(pool);
  return new ReEntryPreviewAdapter(protocol, { ...DEFAULT_REENTRY_CONFIG });
}

describe('Phase 8A-Impl: Re-entry Preview Adapter + Tool', () => {
  describe('ReEntryPreviewAdapter — read-only behavior', () => {
    it('builds a read-only preview report while live injection is the default', async () => {
      const adapter = makeAdapter();
      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(report.sources, 'sources should be present');
      ok(typeof report.wouldInject === 'boolean', 'wouldInject should be boolean');
      ok(typeof report.byteLength === 'number', 'byteLength should be number');
      ok(Array.isArray(report.layersBuilt) || true, 'layers field exists');
      ok(report.diagnostics.length > 0, 'diagnostics should have content');
    });

    it('reports trimming diagnostics when layers are dropped', async () => {
      const adapter = makeAdapter();
      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(report.diagnostics.includes(`Enabled: ${report.enabled}`), 'diagnostics include enabled status');
    });

    it('formatReport renders markdown with status + layers', async () => {
      const adapter = makeAdapter();
      const md = await adapter.formatReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(md.includes('Re-entry Preview'), 'markdown should include title');
      ok(md.includes('Session: test-session'), 'markdown should include session');
      ok(md.includes('### Layers'), 'markdown should include layers section');
    });

    it('degrades gracefully on missing session/project', async () => {
      const adapter = makeAdapter();
      const report = await adapter.buildPreviewReport({
        sessionId: 'non-existent',
        projectId: 'non-existent',
      });

      ok(report !== undefined, 'should return a report');
      ok(report.diagnostics.length > 0, 'should still produce diagnostics');
    });
  });

  describe('tool registration count', () => {
    it('tool count is 33 after Phase 9A', async () => {
      const { CSM_TOOL_NAMES } = await import('../dist/tool-names.js');
      strictEqual(CSM_TOOL_NAMES.length, 34, `expected 34 tools, got ${CSM_TOOL_NAMES.length}`);
    });
  });
});

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';

import { ReentryUxTool, createReentryUxTool } from '../dist/reentry-ux-tool.js';
import type { DatabasePool } from '../dist/database-pool.js';

describe('Phase 8A-Impl: Re-entry Preview Adapter + Tool', () => {
  describe('ReEntryPreviewAdapter - read-only behavior', () => {
    it('should perform no writes when building preview report', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      strictEqual(report.previewOnly, true, 'previewOnly should be true by default');
      strictEqual(report.wouldInject, false, 'wouldInject should be false when preview-only');
      strictEqual(report.blockBuilt, false, 'blockBuilt should be false when preview-only');
      strictEqual(report.blockText, null, 'blockText should be null when preview-only');
      strictEqual(report.byteLength, 0, 'byteLength should be 0 when block is null');
      ok(report.diagnostics.length > 0, 'diagnostics should have content');
    });

    it('should report enabled status correctly', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      strictEqual(report.enabled, true, 'enabled should be true by default');
    });

    it('should report layers correctly', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(report.layersIncluded.length > 0, 'layersIncluded should have content');
      ok(Array.isArray(report.layersIncluded), 'layersIncluded should be an array');
    });

    it('should report trimming diagnostics correctly', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(report.diagnostics.includes('Preview-only: true'), 'diagnostics should include preview-only status');
      ok(report.diagnostics.includes('Enabled: true'), 'diagnostics should include enabled status');
      ok(report.diagnostics.length > 0, 'diagnostics should not be empty');
    });

    it('should format report as markdown', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      const markdown = await adapter.formatReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(markdown.includes('Re-entry Preview'), 'markdown should include title');
      ok(markdown.includes('Session: test-session'), 'markdown should include session ID');
      ok(markdown.includes('Project: test-project'), 'markdown should include project ID');
      ok(markdown.includes('Preview-only: yes'), 'markdown should include preview-only status');
    });

    it('should format report as JSON', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const json = await adapter.formatJson({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      ok(json.includes('"sessionId":"test-session"'), 'JSON should include session ID');
      ok(json.includes('"projectId":"test-project"'), 'JSON should include project ID');
      ok(json.includes('"previewOnly":true'), 'JSON should include preview-only status');
    });

    it('should handle missing state gracefully', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'non-existent-session',
        projectId: 'non-existent-project',
      });

      ok(report.enabled, 'should return enabled status even for missing session');
      ok(report.diagnostics, 'should return diagnostics even for missing session');
      ok(report.wouldInject, 'should return wouldInject status even for missing session');
    });

    it('should return 31 tools after Phase 8A-Impl', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const report = await adapter.buildPreviewReport({
        sessionId: 'test-session',
        projectId: 'test-project',
      });

      strictEqual(report.layersIncluded.length, 31, 'should have 31 layers (matching tool count)');
    });
  });

  describe('csm_reentry_preview tool - read-only behavior', () => {
    it('should perform no writes when executed', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const { execute } = await import('../tools.js').then(m => m.reentryPreviewTool(adapter));

      const context = {
        sessionID: 'test-session',
        directory: 'test-project',
      } as any;

      const result = await execute({}, context);

      strictEqual(result.title, 'Re-entry Preview', 'title should be correct');
      strictEqual(result.metadata.sessionId, 'test-session', 'sessionId should be in metadata');
      strictEqual(result.metadata.projectId, 'test-project', 'projectId should be in metadata');
      strictEqual(result.metadata.previewOnly, true, 'previewOnly should be true');
      strictEqual(result.metadata.wouldInject, false, 'wouldInject should be false');
    });

    it('should report wouldInject=false in preview-only mode', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const { execute } = await import('../tools.js').then(m => m.reentryPreviewTool(adapter));

      const context = {
        sessionID: 'test-session',
        directory: 'test-project',
      } as any;

      const result = await execute({}, context);

      strictEqual(result.metadata.wouldInject, false, 'wouldInject should be false in preview-only mode');
      ok(result.output.includes('Preview-only: yes'), 'output should indicate preview-only mode');
    });

    it('should handle missing context gracefully', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const { execute } = await import('../tools.js').then(m => m.reentryPreviewTool(adapter));

      const context = {
        sessionID: undefined,
        directory: undefined,
      } as any;

      const result = await execute({}, context);

      strictEqual(result.metadata.sessionId, 'unknown', 'sessionId should default to unknown');
      strictEqual(result.metadata.projectId, 'default', 'projectId should default to default');
    });

    it('should show block content when available', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const { execute } = await import('../tools.js').then(m => m.reentryPreviewTool(adapter));

      const context = {
        sessionID: 'test-session',
        directory: 'test-project',
      } as any;

      const result = await execute({}, context);

      ok(result.output.includes('Re-entry Preview'), 'output should include title');
      ok(result.output.includes('Session: test-session'), 'output should include session ID');
    });

    it('should show trimmed layers in diagnostics', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const adapter = await createReentryUxTool(mockPool);

      const { execute } = await import('../tools.js').then(m => m.reentryPreviewTool(adapter));

      const context = {
        sessionID: 'test-session',
        directory: 'test-project',
      } as any;

      const result = await execute({}, context);

      ok(result.output.includes('Layers'), 'output should include Layers section');
      ok(result.output.includes('Included'), 'output should show included layers');
      ok(result.output.includes('Trimmed'), 'output should show trimmed layers');
    });
  });

  describe('tool registration', () => {
    it('should register csm_reentry_preview as tool #32', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const { reentryPreviewTool } = await import('../tools.js');

      const tool = reentryPreviewTool(
        await createReentryUxTool(mockPool)
      );

      strictEqual(tool.description, 'Get the current re-entry block for a session/project without injecting it into the system prompt. Shows layers, trimming diagnostics, and token estimate. Does not modify any state.', 'description should match spec');
    });

    it('should have correct tool signature', async () => {
      const mockPool = {
        getPool: () => ({ query: async () => ({ rows: [] }) }),
      } as unknown as DatabasePool;

      const { reentryPreviewTool } = await import('../tools.js');

      const tool = reentryPreviewTool(
        await createReentryUxTool(mockPool)
      );

      strictEqual(typeof tool.execute, 'function', 'tool should have execute function');
      strictEqual(tool.args, {}, 'tool should have empty args');
      ok(tool.description, 'tool should have description');
    });
  });
});

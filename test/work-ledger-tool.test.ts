import { it } from 'node:test';
import assert from 'node:assert/strict';
import { workLedgerSurvivingTool } from '../src/work-ledger-tool.js';

it('queries the current run and returns machine-readable surviving lineage', async () => {
  const calls: unknown[][] = [];
  const change = {
    changeId: '00000000-0000-4000-8000-000000000001',
    runId: 'run-current',
    modelId: 'openai:gpt-5-codex',
    toolName: 'edit',
    projectRoot: 'C:\\workspace',
    filePath: 'src/a.ts',
    patchHash: 'a'.repeat(64),
    createdAt: new Date('2026-07-10T00:00:00Z'),
    status: 'partially_superseded' as const,
    supersededBy: [],
    supersedes: [],
    survivingPatchHash: 'b'.repeat(64),
    lineageManifest: [],
  };
  const ledger = {
    async listSurvivingChanges(...args: unknown[]) {
      calls.push(args);
      return [change];
    },
  } as any;
  const definition = workLedgerSurvivingTool(
    ledger,
    { runId: 'run-current' } as any,
    'C:\\workspace',
  );
  const result = await definition.execute({}, { sessionID: 'session-1' });
  assert.deepEqual(calls, [['run-current', 'C:\\workspace']]);
  assert.equal(result.metadata.count, 1);
  assert.equal(result.metadata.runComplete, false);
  assert.equal(result.metadata.captureScope, 'supported_file_tools_only');
  assert.match(result.output, /partially_superseded/);
  assert.match(result.output, /src\/a.ts/);
});

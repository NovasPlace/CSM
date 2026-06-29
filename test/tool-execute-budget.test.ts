import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { packageCommandEvidence, packageToolEvidence } from '../src/hooks/tool-execute-budget.js';
import type { PluginContext } from '../src/plugin-context.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'csm-hook-budget-'));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function context(): PluginContext {
  return { directory: tempDir } as PluginContext;
}

describe('tool execute budget adapter', () => {
  it('packages bash output as compact evidence metadata', async () => {
    const metadata = await packageCommandEvidence(
      context(),
      { tool: 'bash', args: { command: 'rg needle src' } },
      {
        output: Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n'),
        metadata: { exitCode: 0 },
      },
    );

    assert.ok(metadata);
    assert.equal(metadata.command, 'rg needle src');
    assert.equal(metadata.exitCode, 0);
    assert.equal(typeof metadata.evidenceRef, 'string');
    assert.equal((metadata.tokensAvoided as number) > 0, true);
    assert.match(String(metadata.promptPayload), /evidence_ref:/);
    assert.doesNotMatch(String(metadata.promptPayload), /line 0\nline 1\nline 2/);
  });

  it('ignores non-bash tools', async () => {
    const metadata = await packageCommandEvidence(
      context(),
      { tool: 'read', args: { filePath: 'src/index.ts' } },
      { output: 'file content', metadata: { exitCode: 0 } },
    );

    assert.equal(metadata, null);
  });

  it('packages read output as compact evidence metadata', async () => {
    const metadata = await packageToolEvidence(
      context(),
      { tool: 'read', args: { filePath: 'src/index.ts' } },
      {
        output: Array.from({ length: 90 }, (_, index) => `const line${index} = value${index};`).join('\n'),
        metadata: { exitCode: 0 },
      },
    );

    assert.ok(metadata);
    assert.equal(metadata.tool, 'read');
    assert.equal(metadata.command, 'read src/index.ts');
    assert.equal(typeof metadata.evidenceRef, 'string');
    assert.equal((metadata.tokensAvoided as number) > 0, true);
    assert.match(String(metadata.promptPayload), /evidence_ref:/);
    assert.doesNotMatch(String(metadata.promptPayload), /const line0 = value0;/);
  });

  it('packages grep output as compact evidence metadata', async () => {
    const metadata = await packageToolEvidence(
      context(),
      { tool: 'grep', args: { pattern: 'TODO', path: 'src' } },
      {
        output: Array.from({ length: 40 }, (_, index) => `src/file${index}.ts:${index}: TODO item ${index}`).join('\n'),
        metadata: { exitCode: 0 },
      },
    );

    assert.ok(metadata);
    assert.equal(metadata.tool, 'grep');
    assert.match(String(metadata.command), /^grep TODO src$/);
    assert.equal(typeof metadata.evidenceRef, 'string');
    assert.equal((metadata.tokensAvoided as number) > 0, true);
  });
});

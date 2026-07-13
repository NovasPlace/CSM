import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentBookToolEventInput } from '../dist/agentbook-tool-event.js';

function build(overrides: Partial<Parameters<typeof buildAgentBookToolEventInput>[0]> = {}) {
  return buildAgentBookToolEventInput({
    projectId: 'test-project',
    sessionId: 'ses_1',
    tool: 'grep',
    callId: 'call_1',
    args: {},
    title: 'Tool result',
    output: 'completed',
    metadata: {},
    ...overrides,
  });
}

it('records read tools as file reads with file evidence', () => {
  const event = build({ tool: 'read', args: { filePath: 'src/index.ts' } });
  assert.equal(event.eventType, 'file_read');
  assert.deepEqual(event.files, ['src/index.ts']);
});

it('does not misclassify non-file tools as file modifications', () => {
  const event = build({ tool: 'grep', args: { pattern: 'AgentBook' } });
  assert.equal(event.eventType, 'note');
  assert.deepEqual(event.files, []);
});

it('records write and edit tools with their actual file paths', () => {
  const created = build({ tool: 'write', args: { path: 'src/new.ts' } });
  const modified = build({ tool: 'apply_patch', args: { file: 'src/existing.ts' } });
  assert.equal(created.eventType, 'file_created');
  assert.deepEqual(created.files, ['src/new.ts']);
  assert.equal(modified.eventType, 'file_modified');
  assert.deepEqual(modified.files, ['src/existing.ts']);
});

it('uses host error metadata to classify failed approaches', () => {
  const event = build({ metadata: { error: 'permission denied' } });
  assert.equal(event.eventType, 'failed_approach');
  assert.equal(event.result, 'error');
  assert.equal(event.metadata?.error, 'permission denied');
});

it('treats non-zero command exits as failures and preserves the command', () => {
  const event = build({
    tool: 'bash',
    args: { command: 'npm test' },
    metadata: { exitCode: 1 },
  });
  assert.equal(event.eventType, 'failed_approach');
  assert.equal(event.command, 'npm test');
  assert.equal(event.result, 'error');
});

it('records successful commands without inventing file modifications', () => {
  const event = build({
    tool: 'bash',
    args: { command: 'npm run build' },
    metadata: { exitCode: 0 },
  });
  assert.equal(event.eventType, 'command_run');
  assert.equal(event.command, 'npm run build');
  assert.equal(event.result, 'success');
});

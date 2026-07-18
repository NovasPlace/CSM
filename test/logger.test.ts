import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { Logger, withLogContext } from '../src/logger.js';

afterEach(() => mock.restoreAll());

describe('operational logger contract', () => {
  it('writes informational logs to stderr so machine-readable stdout stays clean', () => {
    const stdout = mock.method(console, 'log', () => undefined);
    const stderr = mock.method(console, 'error', () => undefined);
    new Logger().info('runtime ready');
    assert.equal(stdout.mock.callCount(), 0);
    assert.equal(stderr.mock.callCount(), 1);
  });

  it('preserves session and project correlation while clearing transient context', () => {
    const writes: string[] = [];
    mock.method(console, 'error', (value: unknown) => writes.push(String(value)));
    const logger = new Logger({ sessionId: 'session-1', projectId: 'project-1', json: true });
    logger.setTurn('turn-1');
    logger.setTool('read');
    logger.clearContext();
    logger.error('operation failed', new Error('failure'));
    const record = JSON.parse(writes[0]) as Record<string, unknown>;
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.projectId, 'project-1');
    assert.equal(record.turnId, undefined);
    assert.equal(record.toolName, undefined);
    assert.equal(record.error, 'failure');
    assert.equal(record.level, 'error');
  });

  it('redacts credentials and named secrets from messages, errors, and JSON fields', () => {
    const writes: string[] = [];
    mock.method(console, 'error', (value: unknown) => writes.push(String(value)));
    const logger = new Logger({
      json: true,
      projectId: 'postgresql://buyer:database-secret@db.example/csm?password=query-secret',
    });
    logger.error(
      'Authorization: Bearer bearer-secret',
      new Error('api_key=provider-secret'),
    );
    const output = writes.join('\n');
    assert.doesNotMatch(output, /database-secret|query-secret|bearer-secret|provider-secret/u);
    assert.match(output, /\[REDACTED\]/u);
  });

  it('keeps concurrent request correlation isolated with async context', async () => {
    const writes: string[] = [];
    mock.method(console, 'error', (value: unknown) => writes.push(String(value)));
    const logger = new Logger({ json: true });
    await Promise.all([
      withLogContext({ projectId: 'project-a', sessionId: 'session-a' }, async () => {
        await Promise.resolve();
        logger.info('request-a');
      }),
      withLogContext({ projectId: 'project-b', sessionId: 'session-b' }, async () => {
        await Promise.resolve();
        logger.info('request-b');
      }),
    ]);
    const records = writes.map((value) => JSON.parse(value) as Record<string, unknown>);
    const a = records.find((record) => record.message === 'request-a');
    const b = records.find((record) => record.message === 'request-b');
    assert.deepEqual([a?.projectId, a?.sessionId], ['project-a', 'session-a']);
    assert.deepEqual([b?.projectId, b?.sessionId], ['project-b', 'session-b']);
  });
});

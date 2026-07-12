import { it } from 'node:test';
import assert from 'node:assert/strict';
import { ReEntryProtocol } from '../src/re-entry-protocol.js';
import { REENTRY_HEADER } from '../src/reentry-contract.js';
import { captureErrorLogs } from './logger-capture.js';

it('preserves the canonical re-entry directive encoding', () => {
  assert.match(REENTRY_HEADER, /context from this block — don't wait/);
  assert.doesNotMatch(REENTRY_HEADER, /â€”/);
});

it('logs identity source failures while preserving a degraded identity layer', async () => {
  const protocol = createProtocol({ layers: ['identity'], poolFailure: true });
  const captured = await captureErrorLogs(
    () => protocol.buildBlockForSourceOnlyTurn('session-1', 'project-1'),
  );
  const block = captured.result;
  assert.match(block ?? '', /## Identity/);
  assert.equal(captured.errors.length, 2);
  assert.match(captured.errors[0][0], /identity/);
});

it('logs work-journal failure and uses the procedural fallback', async () => {
  const protocol = createProtocol({ layers: ['work'], poolFailure: true });
  const captured = await captureErrorLogs(
    () => protocol.buildBlockForSourceOnlyTurn('session-1', 'project-1'),
  );
  const block = captured.result;
  assert.match(block ?? '', /No recent work recorded/);
  assert.equal(captured.errors.length, 1);
  assert.match(captured.errors[0][0], /work journal/);
});

it('logs capability and belief degradation without aborting re-entry', async () => {
  const protocol = createProtocol({ layers: ['capabilities', 'beliefs'], stateFailure: true });
  const captured = await captureErrorLogs(
    () => protocol.buildBlockForSourceOnlyTurn('session-1', 'project-1'),
  );
  const block = captured.result;
  assert.match(block ?? '', /No capability data available/);
  assert.match(block ?? '', /No belief data available/);
  assert.equal(captured.errors.length, 2);
});

it('classifies unexpected TypeError as degraded and preserves its evidence', async () => {
  const protocol = createProtocol({ layers: ['goals'], typeFailure: true });
  const captured = await captureErrorLogs(
    () => protocol.buildBlockForSourceOnlyTurn('session-1', 'project-1'),
  );
  assert.equal(captured.errors.length, 1);
  assert.match(captured.errors[0][0], /goals.*degraded_source/);
  assert.match(captured.errors[0][1]?.message ?? '', /parser defect/);
  assert.deepEqual(captured.errors[0][2], { layer: 'goals', reason: 'degraded_source' });
});

function createProtocol(options: {
  layers: string[];
  poolFailure?: boolean;
  stateFailure?: boolean;
  typeFailure?: boolean;
}): ReEntryProtocol {
  const pool = {
    query: async () => {
      if (options.poolFailure) throw new Error('source unavailable');
      return { rows: [], rowCount: 0 };
    },
  };
  const memoryManager = { listMemories: async () => {
    if (options.typeFailure) throw new TypeError('parser defect');
    return [];
  } };
  const stateSource = async () => {
    if (options.stateFailure) throw new Error('state unavailable');
    return [];
  };
  return new ReEntryProtocol({
    pool, memoryManager,
    selfModel: { getAllCapabilities: stateSource },
    beliefStore: { getBeliefsByKind: stateSource },
    workJournal: {},
    config: { enabled: true, previewOnly: false, layers: options.layers },
  } as never);
}

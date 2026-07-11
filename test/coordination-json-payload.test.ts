import { it } from 'node:test';
import assert from 'node:assert/strict';
import { validateApprovalRequest } from '../src/coordination/approval-service.js';
import { validateCoordinationEvent } from '../src/coordination/event-service.js';
import { approval, event } from './coordination-fixtures.js';

it('accepts a nested JSON event payload', () => {
  const payload = { items: [1, true, null, { label: 'safe' }] };
  assert.deepEqual(validateCoordinationEvent({ ...event(), payload }).payload, payload);
});

it('accepts repeated non-cyclic object references', () => {
  const shared = { value: 1 };
  const payload = { first: shared, second: shared };
  assert.doesNotThrow(() => validateCoordinationEvent({ ...event(), payload }));
});

it('rejects a cyclic event payload', () => {
  const payload: Record<string, unknown> = {};
  payload.self = payload;
  assert.throws(() => validateCoordinationEvent({ ...event(), payload }), /must not contain cycles/);
});

it('rejects a function in an event payload', () => {
  const payload = { action: () => 'unsafe' };
  assert.throws(() => validateCoordinationEvent({ ...event(), payload }), /JSON-compatible/);
});

it('rejects a bigint in an event payload', () => {
  assert.throws(() => validateCoordinationEvent({ ...event(), payload: { count: 1n } }), /JSON-compatible/);
});

it('rejects a non-finite number in an event payload', () => {
  assert.throws(() => validateCoordinationEvent({ ...event(), payload: { count: Infinity } }), /JSON-compatible/);
});

it('rejects a class instance in an event payload', () => {
  assert.throws(() => validateCoordinationEvent({ ...event(), payload: { date: new Date() } }), /plain JSON objects/);
});

it('rejects a sparse array in an event payload', () => {
  const values = new Array(1);
  assert.throws(() => validateCoordinationEvent({ ...event(), payload: { values } }), /sparse slots/);
});

it('rejects custom properties on an event array', () => {
  const values = Object.assign([1], { extra: 2 });
  assert.throws(() => validateCoordinationEvent({ ...event(), payload: { values } }), /array properties/);
});

it('rejects non-enumerable values in an event payload', () => {
  const payload = {};
  Object.defineProperty(payload, 'hidden', { value: 1, enumerable: false });
  assert.throws(() => validateCoordinationEvent({ ...event(), payload }), /enumerable JSON value/);
});

it('rejects accessors without executing them', () => {
  const payload = {};
  Object.defineProperty(payload, 'danger', {
    enumerable: true,
    get: () => { throw new Error('must not execute'); },
  });
  assert.throws(() => validateCoordinationEvent({ ...event(), payload }), /enumerable JSON value/);
});

it('accepts a JSON-compatible approval preview', () => {
  const actionPreview = { assignmentId: 'a1', changes: ['pause'] };
  assert.deepEqual(validateApprovalRequest({ ...approval(), actionPreview }).actionPreview, actionPreview);
});

it('rejects a cyclic approval preview', () => {
  const actionPreview: Record<string, unknown> = {};
  actionPreview.self = actionPreview;
  assert.throws(() => validateApprovalRequest({ ...approval(), actionPreview }), /must not contain cycles/);
});

it('rejects a missing approval preview', () => {
  const { actionPreview: _, ...missing } = approval();
  assert.throws(() => validateApprovalRequest(missing), /JSON-compatible/);
});

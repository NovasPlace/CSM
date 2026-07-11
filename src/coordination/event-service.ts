import {
  requireInteger,
  requireJsonObject,
  requireNullableString,
  requireRecord,
  requireString,
  requireTimestamp,
} from './schema-validation.js';
import type { CoordinationEvent } from './types.js';

export function validateCoordinationEvent(value: unknown): CoordinationEvent {
  const row = requireRecord(value, 'coordination event');
  return {
    id: requireString(row, 'id'), workspaceId: requireString(row, 'workspaceId'),
    assignmentId: requireNullableString(row, 'assignmentId'),
    actorAgentId: requireString(row, 'actorAgentId'), type: requireString(row, 'type'),
    payload: requireJsonObject(row.payload, 'event payload'),
    sequence: requireInteger(row, 'sequence', 1), occurredAt: requireTimestamp(row, 'occurredAt'),
  };
}

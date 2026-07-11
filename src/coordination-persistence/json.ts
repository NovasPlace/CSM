import { createHash } from 'node:crypto';
import { requireJsonValue, type JsonValue } from '../coordination/schema-validation.js';

export function requestHash(value: unknown): string {
  const canonical = canonicalJson(requireJsonValue(value, 'persistence request'));
  return createHash('sha256').update(canonical).digest('hex');
}

export function jsonParameter(value: unknown, label: string): string {
  return JSON.stringify(requireJsonValue(value, label));
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

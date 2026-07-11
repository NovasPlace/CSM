export type UnknownRecord = Record<string, unknown>;
export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

export function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}

export function requireString(record: UnknownRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return value;
}

export function requireNullableString(record: UnknownRecord, key: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${key} must be null or a non-empty string`);
  }
  return value;
}

export function requireBoolean(record: UnknownRecord, key: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') throw new TypeError(`${key} must be boolean`);
  return value;
}

export function requireInteger(record: UnknownRecord, key: string, minimum = 0): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${key} must be an integer >= ${minimum}`);
  }
  return value as number;
}

export function requireArray(record: UnknownRecord, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new TypeError(`${key} must be an array`);
  return value;
}

export function requireStringArray(record: UnknownRecord, key: string): string[] {
  const values = requireArray(record, key);
  if (values.some((value) => typeof value !== 'string')) {
    throw new TypeError(`${key} must contain only strings`);
  }
  return values as string[];
}

export function requireEnum<T extends string>(
  record: UnknownRecord,
  key: string,
  allowed: readonly T[],
): T {
  const value = record[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${key} has an unsupported value`);
  }
  return value as T;
}

export function requireTimestamp(record: UnknownRecord, key: string): string {
  const value = requireString(record, key);
  if (!Number.isFinite(Date.parse(value))) throw new TypeError(`${key} must be a timestamp`);
  return value;
}

export function requireNullableTimestamp(record: UnknownRecord, key: string): string | null {
  const value = requireNullableString(record, key);
  if (value !== null && !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${key} must be null or a timestamp`);
  }
  return value;
}

export function requireJsonValue(value: unknown, label: string): JsonValue {
  return validateJsonValue(value, label, new WeakSet<object>());
}

export function requireJsonObject(
  value: unknown,
  label: string,
): Record<string, JsonValue> {
  const validated = requireJsonValue(value, label);
  if (!validated || typeof validated !== 'object' || Array.isArray(validated)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return validated;
}

function validateJsonValue(
  value: unknown,
  label: string,
  active: WeakSet<object>,
): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') throw new TypeError(`${label} must be JSON-compatible`);
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain JSON objects`);
  }
  if (active.has(value)) throw new TypeError(`${label} must not contain cycles`);
  if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${label} must not contain symbol keys`);
  }
  active.add(value);
  if (Array.isArray(value)) {
    validateJsonArray(value, label, active);
  } else {
    validateJsonObjectEntries(value, label, active);
  }
  active.delete(value);
  return value as JsonValue;
}

function validateJsonArray(value: unknown[], label: string, active: WeakSet<object>): void {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new TypeError(`${label} must not contain sparse slots`);
    validateJsonValue(value[index], `${label}[${index}]`, active);
  }
  const unexpected = Reflect.ownKeys(value).filter((key) =>
    key !== 'length' && (typeof key !== 'string' || !isArrayIndex(key, value.length)));
  if (unexpected.length > 0) throw new TypeError(`${label} must not contain array properties`);
}

function validateJsonObjectEntries(
  value: object,
  label: string,
  active: WeakSet<object>,
): void {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable JSON value`);
    }
    validateJsonValue(descriptor.value, `${label}.${key}`, active);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

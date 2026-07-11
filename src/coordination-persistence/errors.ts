export type PersistenceErrorCode = 'POSTGRES_REQUIRED' | 'NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT' | 'VERSION_CONFLICT' | 'CORRUPT_RECORD';

export class CoordinationPersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: PersistenceErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CoordinationPersistenceError';
    this.code = code;
    this.context = context;
  }
}

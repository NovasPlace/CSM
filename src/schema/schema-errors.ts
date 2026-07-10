export class SchemaStepError extends Error {
  readonly step: string;
  readonly cause: unknown;

  constructor(step: string, cause: unknown, rollbackError?: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const rollbackDetail = rollbackError === undefined
      ? ''
      : `; savepoint rollback failed: ${formatError(rollbackError)}`;
    super(`Schema step failed (${step}): ${detail}${rollbackDetail}`);
    this.name = 'SchemaStepError';
    this.step = step;
    this.cause = rollbackError === undefined
      ? cause
      : new AggregateError([cause, rollbackError], `Migration ${step} and rollback failed`);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

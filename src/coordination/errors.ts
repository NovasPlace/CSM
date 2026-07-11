export const COORDINATION_ERROR_CODES = [
  'WORKSPACE_NOT_FOUND',
  'PRIMARY_AGENT_REQUIRED',
  'INVALID_STATE_TRANSITION',
  'ASSIGNMENT_DEPENDENCY_UNRESOLVED',
  'ASSIGNMENT_SCOPE_VIOLATION',
  'RESOURCE_ALREADY_CLAIMED',
  'RESOURCE_CLAIM_EXPIRED',
  'APPROVAL_REQUIRED',
  'APPROVAL_EXPIRED',
  'VERSION_CONFLICT',
  'HANDOFF_INCOMPLETE',
  'VERIFICATION_REQUIRED',
  'FEATURE_DISABLED',
] as const;

export type CoordinationErrorCode = typeof COORDINATION_ERROR_CODES[number];

export class CoordinationDomainError extends Error {
  readonly code: CoordinationErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: CoordinationErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'CoordinationDomainError';
    this.code = code;
    this.context = context;
  }
}

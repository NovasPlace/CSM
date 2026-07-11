import type { DatabasePool } from '../types.js';
import { createAssignment } from './assignment-operations.js';
import { acquireClaim } from './claim-operations.js';
import { completeAssignment } from './completion-operations.js';
import { listEvents, readWorkspace } from './read-model.js';
import { requireCoordinationPostgres } from './transaction.js';
import type {
  AcquireClaimRequest,
  CompleteAssignmentRequest,
  CreateAssignmentRequest,
  CreateWorkspaceRequest,
  RegisterAgentRequest,
  WorkspaceReadOptions,
} from './types.js';
import { createWorkspace, registerAgent } from './workspace-operations.js';

export class CoordinationPersistenceStore {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    requireCoordinationPostgres(pool);
    this.#pool = pool;
  }

  async createWorkspace(request: CreateWorkspaceRequest) {
    return createWorkspace(this.#pool, request);
  }

  async registerAgent(request: RegisterAgentRequest) {
    return registerAgent(this.#pool, request);
  }

  async createAssignment(request: CreateAssignmentRequest) {
    return createAssignment(this.#pool, request);
  }

  async acquireClaim(request: AcquireClaimRequest) {
    return acquireClaim(this.#pool, request);
  }

  async completeAssignment(request: CompleteAssignmentRequest) {
    return completeAssignment(this.#pool, request);
  }

  async readWorkspace(workspaceId: string, options?: WorkspaceReadOptions) {
    return readWorkspace(this.#pool, workspaceId, options);
  }

  async listEvents(workspaceId: string, afterSequence?: number, limit?: number) {
    return listEvents(this.#pool, workspaceId, afterSequence, limit);
  }
}

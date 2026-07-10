export type WorkLedgerStatus = 'active' | 'partially_superseded' | 'superseded' | 'reverted';

export interface WorkLedgerConfig {
  enabled: boolean;
  maxFileBytes: number;
  captureTimeoutMs: number;
}

export interface LineageManifestEntry {
  hash: string;
  beforeCount: number;
  afterCount: number;
}

export interface WorkLedgerIdentity {
  runId: string;
  sessionId?: string;
  modelId: string;
  toolCallId?: string;
  toolName: string;
}

export interface WorkLedgerChange {
  changeId: string;
  runId: string;
  sessionId?: string;
  modelId: string;
  toolCallId?: string;
  toolName: string;
  projectRoot: string;
  filePath: string;
  beforeHash?: string;
  afterHash?: string;
  patchHash: string;
  commitSha?: string;
  createdAt: Date;
  status: WorkLedgerStatus;
  supersededBy: string[];
  supersedes: string[];
  survivingPatchHash?: string;
  lineageManifest: LineageManifestEntry[];
  lastVerifiedAt?: Date;
}

export interface WorkLedgerCaptureInput extends WorkLedgerIdentity {
  projectRoot: string;
  args: Record<string, unknown>;
}

export interface WorkLedgerSurvival {
  status: WorkLedgerStatus;
  survivingPatchHash?: string;
  survivingUnits: number;
  totalUnits: number;
}

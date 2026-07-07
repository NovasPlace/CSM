import type { DatabasePool } from './types.js';
import { deriveInternalState, deriveNeutralState, type InternalState, type DeriveInput } from './internal-state-deriver.js';
import { getLogger } from './logger.js';

interface PacketRow {
  id: number;
  session_id: string;
  project_id: string | null;
  entry_type: string;
  entry_id: string | null;
  internal_state: string | Record<string, unknown>;
  signals: string | Record<string, unknown>;
  confidence: number;
  created_at: string | Date;
}

export type PacketEntryType =
  | 'tool_execution'
  | 'error'
  | 'milestone'
  | 'decision'
  | 'session_start'
  | 'session_checkpoint'
  | 'session_end'
  | 'distill_group'
  | 'loop_signal';

export interface ExperiencePacket {
  id?: number;
  sessionId: string;
  projectId?: string;
  entryType: PacketEntryType;
  entryId?: string;
  internalState: InternalState;
  signals: Record<string, unknown>;
  confidence: number;
  createdAt?: Date;
}

export class ExperiencePacketCreator {
  constructor(private readonly pool: DatabasePool) {}

  async recordToolPacket(params: {
    sessionId: string;
    projectId?: string;
    toolName: string;
    exitCode?: number;
    error?: string;
    args?: Record<string, unknown>;
    recentErrors?: number;
    previous?: InternalState;
    signals?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const input: DeriveInput = {
      toolName: params.toolName,
      exitCode: params.exitCode,
      error: params.error,
      args: params.args,
      recentErrors: params.recentErrors,
    };
    const state = deriveInternalState(input, params.previous);
    const baseSignals: Record<string, unknown> = {
      toolName: params.toolName,
      argsPreview: summarizeArgs(params.toolName, params.args),
    };
    if (params.exitCode !== undefined) baseSignals.exitCode = params.exitCode;
    if (params.error) baseSignals.error = params.error;

    const signals = params.signals
      ? { ...baseSignals, ...params.signals }
      : baseSignals;

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: params.error ? 'error' : 'tool_execution',
      internalState: state,
      signals,
      confidence: params.error ? 0.8 : 0.6,
    });
  }

  async recordErrorPacket(params: {
    sessionId: string;
    projectId?: string;
    toolName: string;
    error: string;
    exitCode?: number;
    previous?: InternalState;
  }): Promise<ExperiencePacket> {
    const input: DeriveInput = {
      toolName: params.toolName,
      exitCode: params.exitCode,
      error: params.error,
    };
    const state = deriveInternalState(input, params.previous);

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'error',
      internalState: state,
      signals: { toolName: params.toolName, error: params.error, exitCode: params.exitCode },
      confidence: 0.85,
    });
  }

  async recordMilestonePacket(params: {
    sessionId: string;
    projectId?: string;
    intent: string;
    previous?: InternalState;
    signalsMetadata?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const input: DeriveInput = {
      intent: params.intent,
    };
    const state = deriveInternalState(input, params.previous);

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'milestone',
      internalState: state,
      signals: { intent: params.intent, ...params.signalsMetadata },
      confidence: 0.7,
    });
  }

  async recordDecisionPacket(params: {
    sessionId: string;
    projectId?: string;
    intent: string;
    decisionKind?: string;
    confidence?: number;
    previous?: InternalState;
    signalsMetadata?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const state = params.previous ?? deriveNeutralState();
    const signals: Record<string, unknown> = { intent: params.intent };
    if (params.decisionKind) signals.decisionKind = params.decisionKind;
    if (params.signalsMetadata) Object.assign(signals, params.signalsMetadata);

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'decision',
      internalState: state,
      signals,
      confidence: params.confidence ?? 0.5,
    });
  }

  async recordSessionStartPacket(params: {
    sessionId: string;
    projectId?: string;
    signalsMetadata?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const state = deriveNeutralState();

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'session_start',
      internalState: state,
      signals: { ...params.signalsMetadata },
      confidence: 0.9,
    });
  }

  async recordSessionCheckpointPacket(params: {
    sessionId: string;
    projectId?: string;
    messageCount?: number;
    signalsMetadata?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const state = deriveNeutralState();

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'session_checkpoint',
      internalState: state,
      signals: { messageCount: params.messageCount, ...params.signalsMetadata },
      confidence: 0.8,
    });
  }

  async recordSessionEndPacket(params: {
    sessionId: string;
    projectId?: string;
    messageCount?: number;
    previous?: InternalState;
    signalsMetadata?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const state = params.previous ?? deriveNeutralState();

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'session_end',
      internalState: state,
      signals: { messageCount: params.messageCount, ...params.signalsMetadata },
      confidence: 0.9,
    });
  }

  async recordLoopSignalPacket(params: {
    sessionId: string;
    projectId?: string;
    toolName: string;
    callCount: number;
    evidence?: Record<string, unknown>;
    previous?: InternalState;
    signalsMetadata?: Record<string, unknown>;
  }): Promise<ExperiencePacket> {
    const input: DeriveInput = {
      toolName: params.toolName,
      loopDetected: true,
    };
    const state = deriveInternalState(input, params.previous);

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'loop_signal',
      internalState: state,
      signals: { toolName: params.toolName, callCount: params.callCount, ...(params.evidence ?? {}), ...(params.signalsMetadata ?? {}) },
      confidence: 0.9,
    });
  }

  async recordDistillGroupPacket(params: {
    sessionId: string;
    projectId?: string;
    groupCount: number;
    totalCallsSummarized: number;
    compressedPreview: string;
    previous?: InternalState;
  }): Promise<ExperiencePacket> {
    const state = params.previous ?? deriveNeutralState();

    return this.insert({
      sessionId: params.sessionId,
      projectId: params.projectId,
      entryType: 'distill_group',
      internalState: state,
      signals: {
        groupCount: params.groupCount,
        totalCallsSummarized: params.totalCallsSummarized,
        compressedPreview: params.compressedPreview.slice(0, 200),
      },
      confidence: 0.6,
    });
  }

  async getRecentPackets(limit: number): Promise<ExperiencePacket[]> {
    try {
      const result = await this.pool.query(
        `SELECT id, session_id, project_id, entry_type, entry_id,
                internal_state, signals, confidence, created_at
         FROM experience_packets
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row: unknown) => mapPacketRow(row as PacketRow));
    } catch {
      return [];
    }
  }

  async getSessionPackets(sessionId: string, limit: number): Promise<ExperiencePacket[]> {
    try {
      const result = await this.pool.query(
        `SELECT id, session_id, project_id, entry_type, entry_id,
                internal_state, signals, confidence, created_at
         FROM experience_packets
         WHERE session_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [sessionId, limit],
      );
      return result.rows.map((row: unknown) => mapPacketRow(row as PacketRow));
    } catch {
      return [];
    }
  }

  async countBySession(sessionId: string): Promise<number> {
    try {
      const result = await this.pool.query(
        `SELECT COUNT(*) as cnt FROM experience_packets WHERE session_id = $1`,
        [sessionId],
      );
      const row = result.rows[0] as { cnt?: string } | undefined;
      return parseInt(row?.cnt ?? '0', 10);
    } catch {
      return 0;
    }
  }

  async countAll(): Promise<number> {
    try {
      const result = await this.pool.query(`SELECT COUNT(*) as cnt FROM experience_packets`);
      const row = result.rows[0] as { cnt?: string } | undefined;
      return parseInt(row?.cnt ?? '0', 10);
    } catch {
      return 0;
    }
  }

  private async insert(packet: Omit<ExperiencePacket, 'id' | 'createdAt'>): Promise<ExperiencePacket> {
    const internalStateJson = JSON.stringify(packet.internalState);
    const signalsJson = JSON.stringify(packet.signals);

    try {
      const result = await this.pool.query(
        `INSERT INTO experience_packets (session_id, project_id, entry_type, internal_state, signals, confidence)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, session_id, project_id, entry_type, entry_id, internal_state, signals, confidence, created_at`,
        [
          packet.sessionId,
          packet.projectId ?? null,
          packet.entryType,
          internalStateJson,
          signalsJson,
          packet.confidence,
        ],
      );
      return mapPacketRow(result.rows[0] as PacketRow);
    } catch (error) {
      getLogger().error('Failed to insert experience packet', error instanceof Error ? error : undefined);
      throw error;
    }
  }
}

function summarizeArgs(toolName: string | undefined, args: Record<string, unknown> | undefined): string {
  if (!toolName || !args) return '';
  const keys = Object.keys(args);
  if (keys.length === 0) return '';

  if (args.filePath && typeof args.filePath === 'string') return args.filePath;
  if (args.path && typeof args.path === 'string') return args.path;
  if (args.pattern && typeof args.pattern === 'string') {
    const preview = args.pattern as string;
    return preview.length > 40 ? preview.slice(0, 40) + '...' : preview;
  }
  if (args.command && typeof args.command === 'string') {
    const preview = args.command as string;
    return preview.length > 60 ? preview.slice(0, 60) + '...' : preview;
  }
  if (args.query && typeof args.query === 'string') {
    const preview = args.query as string;
    return preview.length > 40 ? preview.slice(0, 40) + '...' : preview;
  }
  if (args.content && typeof args.content === 'string') {
    const preview = args.content as string;
    return preview.length > 40 ? preview.slice(0, 40) + '...' : preview;
  }
  return keys.slice(0, 3).join(', ') + (keys.length > 3 ? ', ...' : '');
}

function mapPacketRow(row: PacketRow): ExperiencePacket {
  const internalStateRaw = typeof row.internal_state === 'string' ? JSON.parse(row.internal_state) : row.internal_state;
  const signalsRaw = typeof row.signals === 'string' ? JSON.parse(row.signals) : row.signals;

  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id ?? undefined,
    entryType: row.entry_type as PacketEntryType,
    entryId: row.entry_id ?? undefined,
    internalState: internalStateRaw as InternalState,
    signals: signalsRaw as Record<string, unknown>,
    confidence: row.confidence,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(row.created_at),
  };
}

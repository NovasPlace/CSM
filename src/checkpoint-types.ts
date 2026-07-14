// Phase 4A — Durable Session Checkpointing types
// All Phase 4A types live here. types.ts is left untouched (already over LOC budget).

/** Recovery handle kinds — matches checkpoint_raw_captures.kind CHECK constraint. */
export type RawCaptureKind = 'tool_output' | 'assistant_text' | 'user_text';

/** A recoverable reference to an original message/part/tool output. */
export interface SourceRef {
  messageId?: string;
  partId?: string;
  toolCallId?: string;
  role: 'user' | 'assistant' | 'tool' | 'unknown';
  kind: RawCaptureKind;
  /** Why this was captured — guides the "expand" decision later. */
  note: string;
}

/** A pointer to a v1-compacted region, for later expansion if needed. */
export interface CompactedRef {
  /** The [COMPACTED] marker text as it appears in the compacted message. */
  marker: string;
  /** Approximate original token count before v1 compaction. */
  approxOriginalTokens: number;
  /** Where it came from. */
  messageId?: string;
  partId?: string;
  toolCallId?: string;
  /** Hint for when to expand it. */
  expandHint: string;
}

/** A stored raw capture row for recovery. */
export interface RawCaptureRecord {
  rawId: string;
  checkpointId: string;
  messageId?: string;
  partId?: string;
  toolCallId?: string;
  kind: RawCaptureKind;
  content: string;
  tokenCount: number;
  capturedAt: Date;
}

/** Input for storing a raw capture. */
export interface StoreRawInput {
  checkpointId: string;
  messageId?: string;
  partId?: string;
  toolCallId?: string;
  kind: RawCaptureKind;
  content: string;
  tokenCount: number;
}

/** A persisted checkpoint row. */
export interface CheckpointRecord {
  checkpointId: string;
  sessionId: string;
  projectId?: string;
  createdAt: Date;
  sourceMessageStart?: string;
  sourceMessageEnd?: string;
  summaryMarkdown: string;
  summaryTokens: number;
  inputTokensEstimate: number;
  sourceRefs: SourceRef[];
  compactedRefs: CompactedRef[];
  filesMentioned: string[];
  testsMentioned: string[];
  risks: string[];
  nextSteps: string[];
  supersedesCheckpointId?: string;
  schemaVersion: number;
  isActive: boolean;
}

/** Input for creating a checkpoint (builder output → store input). */
export interface CreateCheckpointInput {
  sessionId: string;
  projectId?: string;
  sourceMessageStart?: string;
  sourceMessageEnd?: string;
  summaryMarkdown: string;
  summaryTokens: number;
  inputTokensEstimate: number;
  sourceRefs: SourceRef[];
  compactedRefs: CompactedRef[];
  filesMentioned: string[];
  testsMentioned: string[];
  risks: string[];
  nextSteps: string[];
  /** Raw captures to store alongside (recovery data). */
  rawCaptures: StoreRawInput[];
}

/** Telemetry record for a checkpoint event (separate bucket from v1 compaction). */
export interface CheckpointTelemetry {
  sessionId: string;
  checkpointId: string;
  sourceMessageCount: number;
  inputTokens: number;
  summaryTokens: number;
  refsPreserved: number;
  rawCapturesStored: number;
  filesDetected: number;
  testsDetected: number;
  risksDetected: number;
  injectBudgetUsed: number;
  buildMs: number;
  storeMs: number;
  constraintFlag: boolean;
}

/** Recovery result for the expand operation. */
export interface ExpandedRef {
  found: boolean;
  rawCapture?: RawCaptureRecord;
  /** Compact detail if raw unavailable. */
  compactedRef?: CompactedRef;
  error?: string;
}

/** Injection policy configuration (part of PluginConfig.checkpoint). */
export interface CheckpointConfig {
  enabled: boolean;
  maxCheckpointInjectTokens: number;  // default 1200
  minMessagesBeforeInject: number;    // don't inject in short sessions (default 6)
  maxRawCaptureBytes: number;         // per-capture byte cap (default 8192)
  maxRawCapturesPerCheckpoint: number; // safety cap (default 50)
  /** Auto-checkpoint triggers. */
  auto?: AutoCheckpointConfig;
}

/** Auto-checkpoint trigger configuration. */
export interface AutoCheckpointConfig {
  /** Enable auto-checkpoint triggers (default: true if checkpoint.enabled). */
  enabled?: boolean;
  /** Create checkpoint when context pressure exceeds this (0-1, default 0.8). */
  contextPressureThreshold?: number;
  /** Create checkpoint every N messages (default 50). */
  messageCountThreshold?: number;
  /** Tool names that trigger checkpoint before execution (default: write, edit, delete). */
  riskyEditToolPatterns?: string[];
}

/** Minimal view of an OpenCode session message (from ctx.client.session.messages). */
export interface SessionMessage {
  info?: { id?: string; role?: string; created_at?: string };
  parts?: SessionPart[];
}

export interface SessionPart {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type: string;
  text?: string;
  tool?: string;
  /** OpenCode SDK field. */
  callID?: string;
  /** Legacy/internal alias retained for compatibility. */
  toolCallId?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: unknown;
    error?: string;
    time?: { start?: number; end?: number; compacted?: number };
  };
  /** Legacy flattened fields retained for older callers/tests. */
  output?: unknown;
  input?: unknown;
  error?: string;
}

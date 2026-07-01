// Phase 4A — checkpoint telemetry
// Separate [Checkpoint] bucket. Never mixed with v1 compaction accounting.
// Logs to stdout (captured by OpenCode server.log), matching existing plugin pattern.

import { getLogger } from './logger.js';

export interface CheckpointCreatedEvent {
  sessionId: string;
  checkpointId: string;
  sourceMessages: number;
  inputTokens: number;
  summaryTokens: number;
  refsPreserved: number;
  filesDetected: number;
  testsDetected: number;
  risksDetected: number;
  injectBudgetUsed: number;
  elapsedMs: number;
}

export interface CheckpointExpandedEvent {
  sessionId: string;
  refId: string;
  found: boolean;
  kind: string | null;
  tokenCount: number;
  elapsedMs: number;
}

export interface CheckpointListedEvent {
  sessionId: string;
  count: number;
  limit: number;
}

export interface CheckpointInjectedEvent {
  sessionId: string;
  checkpointId: string;
  tokensInjected: number;
  budget: number;
  skipped: boolean;
  reason: string;
}

export function logCheckpointCreated(e: CheckpointCreatedEvent): void {
  getLogger().info(
    `created: session=${e.sessionId} id=${e.checkpointId} ` +
    `source_msgs=${e.sourceMessages} input_tokens=${e.inputTokens} ` +
    `summary_tokens=${e.summaryTokens} refs=${e.refsPreserved} ` +
    `files=${e.filesDetected} tests=${e.testsDetected} ` +
    `risks=${e.risksDetected} inject_used=${e.injectBudgetUsed} ` +
    `elapsed_ms=${e.elapsedMs}`,
    { sessionId: e.sessionId },
  );
}

export function logCheckpointExpanded(e: CheckpointExpandedEvent): void {
  getLogger().info(
    `expanded: session=${e.sessionId} ref=${e.refId} ` +
    `found=${e.found} kind=${e.kind ?? 'null'} ` +
    `tokens=${e.tokenCount} elapsed_ms=${e.elapsedMs}`,
    { sessionId: e.sessionId },
  );
}

export function logCheckpointListed(e: CheckpointListedEvent): void {
  getLogger().info(
    `listed: session=${e.sessionId} count=${e.count} limit=${e.limit}`,
    { sessionId: e.sessionId },
  );
}

export function logCheckpointInjected(e: CheckpointInjectedEvent): void {
  getLogger().info(
    `injected: session=${e.sessionId} id=${e.checkpointId} ` +
    `tokens=${e.tokensInjected} budget=${e.budget} ` +
    `skipped=${e.skipped} reason=${e.reason}`,
    { sessionId: e.sessionId },
  );
}

export function logCheckpointError(operation: string, error: unknown): void {
  const err = error instanceof Error ? error : undefined;
  const msg = error instanceof Error ? error.message : String(error);
  getLogger().error(`op=${operation} msg=${msg}`, err);
}

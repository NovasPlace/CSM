import { estimateTokens } from './token-bucket-analyzer.js';
import type { ResumeEntry } from './work-journal-types.js';
import { deriveTeacherTraceCards, formatTeacherTraceCards } from './teacher-trace-core.js';
import type { TraceVaultCaptureInput, TraceVaultCaptureResult } from './trace-vault-types.js';

export function buildTraceVaultCapture(input: TraceVaultCaptureInput, entries: ResumeEntry[]): TraceVaultCaptureResult {
  const ordered = [...entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const rawTrace = buildRawTrace(ordered);
  const cards = deriveTeacherTraceCards(ordered);
  const condensedTrace = formatTeacherTraceCards(cards);
  return {
    id: 0,
    sessionId: input.sessionId,
    projectId: input.projectId,
    sourceLabel: input.sourceLabel,
    rawTrace,
    condensedTrace,
    rawTokens: estimateTokens(rawTrace),
    condensedTokens: estimateTokens(condensedTrace),
    cards,
    capturedAt: new Date().toISOString(),
  };
}

export function formatTraceVaultCapture(capture: TraceVaultCaptureResult): string {
  return [
    `### Vault trace ${capture.id || 'preview'}: ${capture.sourceLabel}`,
    `Session: ${capture.sessionId}`,
    `Raw tokens: ${capture.rawTokens}`,
    `Condensed tokens: ${capture.condensedTokens}`,
    `Entries: ${capture.rawTrace.split('\n').length}`,
    `Condensed trace: ${truncate(capture.condensedTrace, 160)}`,
  ].join('\n');
}

function buildRawTrace(entries: ResumeEntry[]): string {
  return entries.map((entry) => [
    `[${entry.entryType}] ${entry.toolName ?? 'journal'}`,
    entry.intent,
    entry.target ? `target=${entry.target}` : '',
    entry.resultSummary ? `result=${entry.resultSummary}` : '',
    entry.errorSummary ? `error=${entry.errorSummary}` : '',
    entry.filesTouched.length > 0 ? `files=${entry.filesTouched.join(',')}` : '',
  ].filter(Boolean).join(' | ')).join('\n');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

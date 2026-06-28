import type { TeacherTraceCard } from './teacher-trace-types.js';

export interface TraceVaultCaptureInput {
  sessionId: string;
  projectId?: string;
  sourceLabel: string;
}

export interface TraceVaultCaptureResult {
  id: number;
  sessionId: string;
  projectId?: string;
  sourceLabel: string;
  rawTrace: string;
  condensedTrace: string;
  rawTokens: number;
  condensedTokens: number;
  cards: TeacherTraceCard[];
  capturedAt: string;
}

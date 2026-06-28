import type { MemoryType, MemorySearchMode, SortBy } from './types.js';

type ToolArgs = Record<string, unknown>;

const MEMORY_TYPES: MemoryType[] = ['conversation', 'workspace', 'repo', 'preference', 'lesson', 'episodic', 'procedural', 'self_continuity'];
const SEARCH_MODES: MemorySearchMode[] = ['project', 'legacy', 'global'];
const SORT_OPTIONS: SortBy[] = ['recent', 'important', 'accessed'];

export const VAULT_TOOL_SPECS = [
  toolSpec('preview_teacher_traces', 'Preview repair cards derived from a work journal trace.', { sessionId: { type: 'string', description: 'Session id to inspect.' }, projectRoot: { type: 'string', description: 'Project root or identifier.' }, limit: { type: 'number', description: 'Max journal entries to inspect.', default: 50 } }, ['sessionId']),
  toolSpec('seed_teacher_traces', 'Derive and save teacher-trace repair cards from a work journal trace.', { sessionId: { type: 'string', description: 'Session id to inspect.' }, projectRoot: { type: 'string', description: 'Project root or identifier.' }, limit: { type: 'number', description: 'Max journal entries to inspect.', default: 50 } }, ['sessionId']),
  toolSpec('capture_trace_vault', 'Capture a raw journal trace into a persisted vault record.', { sessionId: { type: 'string', description: 'Session id to inspect.' }, projectRoot: { type: 'string', description: 'Project root or identifier.' }, sourceLabel: { type: 'string', description: 'Label for the captured trace.', default: 'work_journal' } }, ['sessionId']),
  toolSpec('preview_trace_vault', 'Preview persisted trace vault entries for a session.', { sessionId: { type: 'string', description: 'Session id to inspect.' }, projectRoot: { type: 'string', description: 'Project root or identifier.' }, limit: { type: 'number', description: 'Max vault entries to return.', default: 5 } }, ['sessionId']),
  toolSpec('seed_teacher_traces_from_vault', 'Seed teacher traces from a persisted vault record.', { sessionId: { type: 'string', description: 'Session id to inspect.' }, projectRoot: { type: 'string', description: 'Project root or identifier.' }, limit: { type: 'number', description: 'Max vault entries to use.', default: 5 } }, ['sessionId']),
];

export function teacherTraceArgs(args: ToolArgs) {
  return { sessionId: requiredString(args.sessionId, 'sessionId'), projectRoot: defaultProject(args.projectRoot), limit: optionalNumber(args.limit) ?? 50 };
}

export function traceVaultArgs(args: ToolArgs) {
  return { sessionId: requiredString(args.sessionId, 'sessionId'), projectRoot: defaultProject(args.projectRoot), sourceLabel: optionalString(args.sourceLabel) ?? 'work_journal' };
}

export function traceVaultPreviewArgs(args: ToolArgs) {
  return { sessionId: requiredString(args.sessionId, 'sessionId'), projectRoot: defaultProject(args.projectRoot), limit: optionalNumber(args.limit) ?? 5 };
}

function toolSpec(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { name, title: name, description, inputSchema: { type: 'object', properties, required } };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function defaultProject(value: unknown): string {
  return optionalString(value) ?? process.cwd().split(/[\\/]/).pop() ?? 'cross-session-memory';
}

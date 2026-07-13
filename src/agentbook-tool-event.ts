import type { AgentBookEventInput, AgentBookEventType } from './agentbook-types.js';

interface ToolEventMetadata {
  tokenCount?: number;
  error?: string;
  exitCode?: number;
}

export interface AgentBookToolEventInput {
  projectId: string;
  sessionId: string | null;
  tool: string;
  callId: string;
  args: Record<string, unknown>;
  title: string;
  output: string;
  metadata: ToolEventMetadata;
}

const COMMAND_TOOLS = new Set(['bash', 'shell', 'terminal']);
const FILE_READ_TOOLS = new Set(['read']);
const FILE_CREATE_TOOLS = new Set(['write']);
const FILE_MODIFY_TOOLS = new Set(['edit', 'multiedit', 'patch', 'apply_patch']);
const FILE_DELETE_TOOLS = new Set(['delete', 'delete_file', 'remove_file']);

function classifyToolEvent(tool: string, failed: boolean): AgentBookEventType {
  if (failed) return 'failed_approach';
  if (COMMAND_TOOLS.has(tool)) return 'command_run';
  if (FILE_READ_TOOLS.has(tool)) return 'file_read';
  if (FILE_CREATE_TOOLS.has(tool)) return 'file_created';
  if (FILE_MODIFY_TOOLS.has(tool)) return 'file_modified';
  if (FILE_DELETE_TOOLS.has(tool)) return 'file_deleted';
  return 'note';
}

function addPath(paths: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const normalized = value.trim();
  if (normalized && !paths.includes(normalized)) paths.push(normalized);
}

function extractFiles(args: Record<string, unknown>): string[] {
  const files: string[] = [];
  addPath(files, args.filePath);
  addPath(files, args.path);
  addPath(files, args.file);

  for (const key of ['files', 'paths']) {
    const value = args[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) addPath(files, entry);
  }
  return files;
}

function commandFor(tool: string, args: Record<string, unknown>): string | null {
  if (!COMMAND_TOOLS.has(tool)) return null;
  return typeof args.command === 'string' ? args.command : null;
}

function buildMetadata(input: AgentBookToolEventInput): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    tool: input.tool,
    callId: input.callId,
  };
  if (input.metadata.error) metadata.error = input.metadata.error;
  if (input.metadata.exitCode !== undefined) metadata.exitCode = input.metadata.exitCode;
  if (input.metadata.tokenCount !== undefined) metadata.tokenCount = input.metadata.tokenCount;
  return metadata;
}

export function buildAgentBookToolEventInput(input: AgentBookToolEventInput): AgentBookEventInput {
  const tool = input.tool.trim().toLowerCase();
  const failed = Boolean(input.metadata.error)
    || (input.metadata.exitCode !== undefined && input.metadata.exitCode !== 0);
  const detail = input.output.trim() || input.title.trim() || (failed ? 'failed' : 'completed');

  return {
    projectId: input.projectId,
    sessionId: input.sessionId,
    eventType: classifyToolEvent(tool, failed),
    summary: `${input.tool}: ${detail.slice(0, 200)}`,
    files: extractFiles(input.args),
    command: commandFor(tool, input.args),
    result: failed ? 'error' : 'success',
    metadata: buildMetadata(input),
  };
}

import { storeItem } from './context-cache-store.js';
import type { DatabasePool } from './types.js';

export async function cacheBridgeTurnSignal(
  pool: DatabasePool,
  input: { sessionId: string; projectId: string; role: 'user' | 'assistant' | 'system'; content: string },
): Promise<void> {
  const kind = input.role === 'user' ? 'turn' : 'decision';
  const trimmed = input.content.replace(/\s+/g, ' ').trim();
  if (!trimmed) return;
  const createdAt = Date.now();
  await storeItem(pool, {
    sessionId: input.sessionId,
    displayId: `bridge_${kind}_${createdAt}`,
    kind,
    createdAt,
    summary: summarize(`[${input.role}] ${trimmed}`, 160),
    content: trimmed,
    metadata: { projectId: input.projectId, role: input.role, source: 'bridge_sync_turn' },
  });
}

export async function cacheToolErrorSignal(
  pool: DatabasePool,
  input: {
    sessionId: string;
    toolName: string;
    args?: Record<string, unknown>;
    output: string;
    error?: string;
    exitCode?: number;
  },
): Promise<void> {
  if (!isToolError(input)) return;
  const createdAt = Date.now();
  const details = input.error?.trim() || input.output.trim();
  await storeItem(pool, {
    sessionId: input.sessionId,
    displayId: `tool_error_${createdAt}`,
    kind: 'error',
    createdAt,
    summary: summarize(`error in ${input.toolName}: ${details}`, 160),
    content: details || `Command failed in ${input.toolName}.`,
    metadata: {
      tool: input.toolName,
      exitCode: input.exitCode ?? null,
      command: readCommand(input.args),
      filePath: readFilePath(input.args),
      source: 'tool_execute_after',
    },
  });
}

export async function cacheBridgeWorkflowSignal(
  pool: DatabasePool,
  input: {
    sessionId: string;
    projectId: string;
    task: string;
    source: 'bridge_handoff_summary' | 'bridge_resume_context';
    summary: string;
    content: string;
    actionPlan?: string[];
    activeGoal?: string;
    nextStep?: string;
    checkpointId?: string;
    lastErrorId?: string;
  },
): Promise<void> {
  if (!input.content.trim()) return;
  const createdAt = Date.now();
  await storeItem(pool, {
    sessionId: input.sessionId,
    displayId: `${input.source}_${createdAt}`,
    kind: 'decision',
    createdAt,
    summary: summarize(input.summary, 160),
    content: input.content.trim(),
    metadata: {
      projectId: input.projectId,
      task: input.task,
      source: input.source,
      actionPlan: input.actionPlan ?? [],
      activeGoal: input.activeGoal,
      nextStep: input.nextStep,
      checkpointId: input.checkpointId,
      lastErrorId: input.lastErrorId,
    },
  });
}

function isToolError(input: { error?: string; exitCode?: number; output: string }): boolean {
  if (input.error) return true;
  if (input.exitCode !== undefined && input.exitCode !== 0) return true;
  return false;
}

function readCommand(args?: Record<string, unknown>): string | undefined {
  return typeof args?.command === 'string' ? args.command.slice(0, 160) : undefined;
}

function readFilePath(args?: Record<string, unknown>): string | undefined {
  if (typeof args?.filePath === 'string') return args.filePath;
  return typeof args?.path === 'string' ? args.path : undefined;
}

function summarize(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

const DECISION_PATTERNS = /\b(should|must|never|always|only|do not|don't|keep|preserve|use|prefer|avoid|require|ban|forbid)\b/i;
const DECISION_BOOSTERS = /\b(all files|every time|as a rule|going forward|from now on|this is how|the convention|the standard)\b/i;
const DECISION_WEAKENERS = /\b(maybe|perhaps|might|could|what if|what about|thoughts|ideas?|brainstorm)\b/i;

export function detectDecisionIntent(text: string): { confidence: number; matchedPattern: string | null } {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length < 10 || trimmed.length > 500) return { confidence: 0, matchedPattern: null };

  const hasPattern = DECISION_PATTERNS.test(trimmed);
  if (!hasPattern) return { confidence: 0, matchedPattern: null };

  const match = trimmed.match(DECISION_PATTERNS);
  const matchedPattern = match?.[0]?.toLowerCase() ?? null;

  let confidence = 0.4;
  if (DECISION_BOOSTERS.test(trimmed)) confidence += 0.3;
  if (DECISION_WEAKENERS.test(trimmed)) confidence -= 0.3;
  if (/^[A-Z]/.test(trimmed) && /[.!?]\s*$/.test(trimmed)) confidence += 0.1;
  if (trimmed.length > 30 && trimmed.length < 200) confidence += 0.1;

  return { confidence: Math.max(0, Math.min(1, confidence)), matchedPattern };
}

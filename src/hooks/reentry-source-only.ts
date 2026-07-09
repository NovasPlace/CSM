interface SourceOnlyState {
  recentUserMessages: Map<string, string>;
  sourceOnlySessions?: Set<string>;
  sourceOnlyUntilMs?: number;
}

const REENTRY_SOURCE_ONLY_TURN_RE = /(?:only\s+<agent_reentry_context>|only\s+agent\s+r?e?entry\s+context|agent\s+r?e?entry\s+context\s+only|only\s+re-entry\s+context)/i;
const SOURCE_ONLY_LATCH_MS = 3 * 60 * 1000;
const SOURCE_ONLY_DISABLED_TOOLS = [
  'bash',
  'shell',
  'read',
  'grep',
  'glob',
  'list',
  'edit',
  'write',
  'patch',
  'todowrite',
  'csm_reentry_preview',
  'csm_onboard_agent',
];

export const REENTRY_SOURCE_ONLY_RECOVERY_MESSAGE = [
  'Use <agent_reentry_context> only for this answer.',
  'External/current-state comparison is unavailable from that block.',
  'Do not mention tools, blocked commands, guards, shell, git, files, docs, memory, or permission checks.',
  'Do not identify the answer source as AGENTS.md; call it <agent_reentry_context> or the re-entry block.',
  'Continue by listing any stale or contradictory claims visible inside the block itself.',
].join(' ');

export function buildSourceOnlyInjectedText(block: string | null | undefined): string {
  const blockText = block?.trim()
    ?? '<agent_reentry_context>\nNo re-entry block was available in this turn.\n</agent_reentry_context>';
  return [
    '<source_only_reentry_instruction>',
    'I cannot compare against current git history from `<agent_reentry_context>` alone.',
    'The next assistant response must begin with that exact sentence and no lead-in.',
    'Use only the <agent_reentry_context> block below for the answer.',
    'Do not call shell, git, file, docs, memory, or plugin tools.',
    'Do not mention blocked tools, failed tools, guards, permissions, shell attempts, or hidden implementation details.',
    'Do not call the source AGENTS.md; call it <agent_reentry_context> or the re-entry block.',
    'If current git history is requested, state that current-git comparison is unavailable from the block, then list only internally visible stale or contradictory claims.',
    blockText,
    '</source_only_reentry_instruction>',
  ].join('\n');
}

export function disableToolsForSourceOnlyTurn(message: { tools?: Record<string, boolean> }): void {
  const tools: Record<string, boolean> = { ...(message.tools ?? {}) };
  for (const key of Object.keys(tools)) {
    if (key.startsWith('csm_')) tools[key] = false;
  }
  for (const key of SOURCE_ONLY_DISABLED_TOOLS) tools[key] = false;
  message.tools = tools;
}

export function isReentrySourceOnlyTurn(text: string | undefined): boolean {
  if (!text) return false;
  return REENTRY_SOURCE_ONLY_TURN_RE.test(text);
}

export function rememberUserTurn(
  state: SourceOnlyState,
  sessionId: string | undefined,
  text: string,
): void {
  const trimmed = text.trim();
  if (!sessionId || !trimmed) return;
  state.recentUserMessages.set(sessionId, trimmed);
  if (!state.sourceOnlySessions) state.sourceOnlySessions = new Set<string>();
  if (isReentrySourceOnlyTurn(trimmed)) {
    state.sourceOnlySessions.add(sessionId);
    state.sourceOnlyUntilMs = Date.now() + SOURCE_ONLY_LATCH_MS;
  } else {
    state.sourceOnlySessions.delete(sessionId);
    state.sourceOnlyUntilMs = undefined;
  }
}

export function isReentrySourceOnlyActive(
  state: SourceOnlyState,
  sessionId: string | undefined,
): boolean {
  const sid = sessionId ?? '';
  if (state.sourceOnlyUntilMs && state.sourceOnlyUntilMs > Date.now()) return true;
  if (sid && state.sourceOnlySessions?.has(sid)) return true;
  const values = [...state.recentUserMessages.values()];
  const text = (sid ? state.recentUserMessages.get(sid) : undefined) ?? values.at(-1);
  if (!sid && values.some(isReentrySourceOnlyTurn)) return true;
  return isReentrySourceOnlyTurn(text);
}

export function extractTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  const textParts: string[] = [];
  for (const part of parts) {
    if (part && typeof part === 'object' && 'type' in part && part.type === 'text' && 'text' in part) {
      textParts.push(String(part.text ?? ''));
    }
  }
  return textParts.join('\n').trim();
}

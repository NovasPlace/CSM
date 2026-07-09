interface SourceOnlyState {
  recentUserMessages: Map<string, string>;
  sourceOnlySessions?: Set<string>;
}

const REENTRY_SOURCE_ONLY_TURN_RE = /(?:only\s+<agent_reentry_context>|only\s+agent\s+r?e?entry\s+context|agent\s+r?e?entry\s+context\s+only|only\s+re-entry\s+context)/i;

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
  } else {
    state.sourceOnlySessions.delete(sessionId);
  }
}

export function isReentrySourceOnlyActive(
  state: SourceOnlyState,
  sessionId: string | undefined,
): boolean {
  const sid = sessionId ?? '';
  if (sid && state.sourceOnlySessions?.has(sid)) return true;
  const text = (sid ? state.recentUserMessages.get(sid) : undefined)
    ?? [...state.recentUserMessages.values()].pop();
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

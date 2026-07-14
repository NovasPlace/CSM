import { getLogger } from '../logger.js';
import { extractTextParts } from './reentry-source-only.js';
import type {
  SystemTransformInput,
  SystemTransformOutput,
} from './system-transform-live-types.js';

const GREETING_TURN_RE = /^(hi|hello|hey|yo|sup|what'?s up|howdy|hiya|good morning|good afternoon|good evening)\b[!.? ]*$/i;
const WORKSPACE_FACT_TURN_RE = /\b(phase\s+\d+|changelog|system map|readme|docs?|workspace|repo|repository|file|files|search the repo|search the workspace)\b/i;
export const GREETING_GUIDANCE = 'Current user turn is a simple greeting. Reply briefly and warmly in plain language. Do not call memory tools for this turn.';
const CONTINUITY_GREETING_GUIDANCE = 'Current user turn is a simple greeting, BUT this is the first turn of a session and a re-entry / onboarding context block was injected. Reply briefly and warmly, then surface continuity in 1-3 lines: acknowledge you are resuming (e.g. project name, prior session, open threads, current phase). Do not call memory tools — answer from the injected block. Do not pretend to be a blank chatbot.';

export function normalizeSystemEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry == null) return '';
      try {
        return JSON.stringify(entry);
      } catch {
        return String(entry);
      }
    })
    .filter((entry) => entry.length > 0);
}

export function isGreetingLikeTurn(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && GREETING_TURN_RE.test(trimmed);
}

export function isWorkspaceFactTurn(text: string | undefined): boolean {
  if (!text) return false;
  return WORKSPACE_FACT_TURN_RE.test(text);
}

export function getLatestInputTurn(
  messages: SystemTransformInput['messages'],
): string | undefined {
  if (!messages?.length) return undefined;
  const userTurns = messages
    .filter((message) => (message.info?.role ?? message.role ?? 'user') === 'user')
    .map((message) => message.content?.trim() || extractTextParts(message.parts).trim())
    .filter(Boolean);
  return userTurns.at(-1);
}

export function upgradeGreetingGuidance(output: SystemTransformOutput): void {
  const index = output.system.indexOf(GREETING_GUIDANCE);
  if (index >= 0) output.system[index] = CONTINUITY_GREETING_GUIDANCE;
}

export function logTransformFailure(
  error: unknown,
  output: SystemTransformOutput,
): void {
  getLogger().error(
    'Context injection error',
    error instanceof Error ? error : new Error(String(error)),
  );
  output.system = normalizeSystemEntries(output.system);
}


/**
 * Phase 6 — Context Rollover: continuation brief compiler.
 *
 * Scans old messages and extracts the critical context that must survive
 * rollover: active goal, current task, active files, latest errors,
 * user constraints, pending plan, and memory references.
 *
 * The brief is plain text (markdown-like) so the model can read it as
 * a single system message.
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import { RolloverConfig } from './context-rollover-config.js';

interface RolloverBriefPart {
  type?: string;
  text?: string;
  output?: string;
  args?: Record<string, unknown>;
}

interface MessageLike {
  info?: { role?: string; sessionID?: string };
  parts?: RolloverBriefPart[];
}

function extractText(parts: RolloverBriefPart[] | undefined): string {
  if (!parts) return '';
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

function extractFilePaths(parts: RolloverBriefPart[] | undefined): string[] {
  if (!parts) return [];
  const paths: string[] = [];
  for (const p of parts) {
    if (p?.type !== 'tool') continue;
    const args = p.args;
    if (!args || typeof args !== 'object') continue;
    for (const key of ['filePath', 'path', 'file', 'filename']) {
      const v = args[key];
      if (typeof v === 'string' && v.length > 2) paths.push(v);
    }
  }
  return paths;
}

function extractErrors(parts: RolloverBriefPart[] | undefined): string[] {
  if (!parts) return [];
  const errors: string[] = [];
  for (const p of parts) {
    if (p?.type !== 'tool') continue;
    const output = p.output;
    if (typeof output !== 'string') continue;
    if (output.includes('error') || output.includes('Error') || output.includes('FAIL')) {
      const firstLine = output.split('\n').find((l) =>
        l.includes('error') || l.includes('Error') || l.includes('FAIL'));
      if (firstLine) errors.push(firstLine.trim().slice(0, 200));
    }
  }
  return errors;
}

function findLastUserGoal(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info?.role === 'user') {
      const text = extractText(m.parts);
      if (text.trim()) return text.trim().slice(0, 500);
    }
  }
  return '(no explicit user goal found in archived context)';
}

function findCurrentTask(messages: MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.info?.role === 'assistant') {
      const text = extractText(m.parts);
      if (text.trim()) return text.trim().slice(0, 500);
    }
  }
  return '(no recent assistant action found)';
}

function collectActiveFiles(messages: MessageLike[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) {
    for (const fp of extractFilePaths(m.parts)) {
      seen.add(fp);
    }
  }
  return Array.from(seen).slice(0, 20);
}

function collectErrors(messages: MessageLike[]): string[] {
  const seen = new Set<string>();
  for (const m of messages) {
    for (const err of extractErrors(m.parts)) {
      seen.add(err);
    }
  }
  return Array.from(seen).slice(0, 10);
}

const DEFAULT_CONSTRAINTS = [
  'No silent file writes — explicit approval required for destructive changes',
  'PostgreSQL only — SQLite/Redis/ORM forbidden',
  'Token cap enforced — fail closed if prompt exceeds hard limit',
];

export interface ContinuationBrief {
  text: string;
  tokens: number;
}

function renderBriefSections(
  sessionId: string,
  msgCount: number,
  activeGoal: string,
  currentTask: string,
  activeFiles: string[],
  latestErrors: string[],
): string[] {
  const s: string[] = [];
  s.push(`## Context Rollover — Continuation Brief`);
  s.push(`(session ${sessionId} | ${msgCount} messages archived to context cache)`);
  s.push('', `### Active Goal`, activeGoal, '');
  s.push(`### Current Task`, currentTask, '');
  s.push(`### Active Files`);
  if (activeFiles.length > 0) {
    for (const f of activeFiles) s.push(`- ${f}`);
  } else {
    s.push('(none detected in archived messages)');
  }
  s.push('');
  s.push(`### Latest Errors`);
  if (latestErrors.length > 0) {
    for (const e of latestErrors) s.push(`- ${e}`);
  } else {
    s.push('(none detected)');
  }
  return s;
}

function renderBriefFooter(): string[] {
  const s: string[] = [];
  s.push('');
  s.push(`### User Constraints`);
  for (const c of DEFAULT_CONSTRAINTS) s.push(`- ${c}`);
  s.push('');
  s.push(`### Pending Plan`);
  s.push('(Continue from current task above. Archived messages available via context cache fetch tools.)');
  s.push('');
  s.push(`### Memory References`);
  s.push('(Use context_search / context_fetch to retrieve archived tool outputs, file reads, and decisions.)');
  return s;
}

export function buildContinuationBrief(
  messages: MessageLike[],
  config: RolloverConfig,
  sessionId: string,
): ContinuationBrief {
  const activeGoal = findLastUserGoal(messages);
  const currentTask = findCurrentTask(messages);
  const activeFiles = collectActiveFiles(messages);
  const latestErrors = collectErrors(messages);

  const sections = [
    ...renderBriefSections(sessionId, messages.length, activeGoal, currentTask, activeFiles, latestErrors),
    ...renderBriefFooter(),
  ];

  let text = sections.join('\n');
  const tokens = estimateTokens(text);
  if (tokens > config.maxBriefTokens) {
    const charBudget = config.maxBriefTokens * 4;
    text = text.slice(0, charBudget) + '\n\n[brief truncated to fit token budget]';
  }
  return { text, tokens: estimateTokens(text) };
}

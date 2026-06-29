import type { ResumePayload } from './work-journal-types.js';
import { compactResumeEntries, compactResumeFiles } from './prompt-budget-injection.js';
import { estimateTokens } from './token-bucket-analyzer.js';

export interface WorkJournalInjectDeps {
  maxInjectTokens: number;
}

export function buildResumeInjection(
  payload: ResumePayload,
  deps: WorkJournalInjectDeps,
): string {
  const entryLines = payload.entries.map((entry) => {
    const tag = entry.entryType;
    const tool = entry.toolName ? ` ${entry.toolName}` : '';
    const target = entry.target ? ` ${truncate(entry.target, 60)}` : '';
    const intent = truncate(entry.intent, 180);
    const result = entry.resultSummary ? ` - ${truncate(entry.resultSummary, 100)}` : '';
    const errTag = entry.errorSummary ? ` [ERROR: ${truncate(entry.errorSummary, 80)}]` : '';
    return `### [${tag}${tool}] ${intent}${target}${result}${errTag}`;
  });
  const files = compactResumeFiles(payload.allFilesTouched, 8);
  const fullLines = buildLines(payload, compactResumeEntries(entryLines, Math.max(120, Math.floor(deps.maxInjectTokens * 0.45))), files, payload.allFilesTouched.length > files.length, false);
  if (estimateTokens(fullLines.join('\n')) <= deps.maxInjectTokens) {
    return fullLines.join('\n');
  }

  const fallbackEntries = compactResumeEntries(entryLines, Math.max(40, Math.floor(deps.maxInjectTokens * 0.2)));
  const fallbackFiles = compactResumeFiles(payload.allFilesTouched, 3);
  return buildLines(payload, fallbackEntries, fallbackFiles, payload.allFilesTouched.length > fallbackFiles.length, true).join('\n');
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen)}...`;
}

function buildLines(
  payload: ResumePayload,
  entryLines: string[],
  files: string[],
  filesDistilled: boolean,
  truncated: boolean,
): string[] {
  const lines: string[] = [
    `<work_resume from_session="${payload.fromSessionId.slice(0, 12)}" last_active="${payload.lastActiveAt.toISOString().substring(0, 19)}Z">`,
    '',
    `## Prior Session Work (${payload.totalEntries} entries, ${payload.entries.length} most recent shown)`,
    '',
    ...entryLines,
    '',
  ];

  if (payload.activeGoal) lines.push('## Active Goal', payload.activeGoal, '');
  if (payload.nextStepInferred) lines.push('## Inferred Next Step', payload.nextStepInferred, '');

  if (files.length > 0) {
    lines.push('## Files Touched (prior session)');
    for (const file of files) {
      if (!file.startsWith('search:')) lines.push(`- ${file}`);
    }
    if (filesDistilled) lines.push('- ... [files distilled for budget]');
    lines.push('');
  }

  if (truncated) lines.push('[Resume truncated for budget]', '');
  lines.push('</work_resume>');
  return lines;
}

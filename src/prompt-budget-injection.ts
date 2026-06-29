import { estimateTokens } from './token-bucket-analyzer.js';

const SIGNAL_LINE = /^(## |### |- )|goal|constraint|risk|next step|decision|error|fail|src\/|test\//i;
const FILE_SIGNAL = /^(src|test|tests|docs)\//i;

function trimToBudget(text: string, maxTokens: number, suffix: string): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const maxChars = Math.max(80, Math.ceil(maxTokens * 3.5) - suffix.length - 1);
  return `${text.slice(0, maxChars)}\n${suffix}`;
}

export function compactCheckpointMarkdown(markdown: string, maxTokens: number): string {
  const kept = markdown
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line, index) => index < 8 || SIGNAL_LINE.test(line))
    .map((line) => line.length > 200 ? `${line.slice(0, 200)}...` : line)
    .slice(0, 24);
  return trimToBudget(kept.join('\n'), maxTokens, '... [checkpoint distilled for budget]');
}

export function compactResumeFiles(files: string[], maxItems: number): string[] {
  return files
    .filter((file) => FILE_SIGNAL.test(file))
    .filter((file) => !file.startsWith('docs/'))
    .slice(0, maxItems);
}

export function compactResumeEntries(lines: string[], maxTokens: number): string[] {
  const kept: string[] = [];
  for (const line of lines) {
    kept.push(line);
    if (estimateTokens(kept.join('\n')) > maxTokens) {
      kept.pop();
      break;
    }
  }
  return kept;
}

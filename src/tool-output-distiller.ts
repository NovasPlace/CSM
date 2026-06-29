import { estimateTokens } from './token-bucket-analyzer.js';
import { EvidenceVault, type EvidenceRecordInput } from './evidence-vault.js';

export interface ShellOutputInput extends EvidenceRecordInput {
  maxTailLines?: number;
  maxFailureLines?: number;
}

export interface DistilledShellOutput {
  command: string;
  cwd: string;
  exitCode: number;
  status: 'success' | 'failure';
  summary: string;
  evidenceRef: string;
  displayRef: string;
  failureLines: string[];
  tail: string[];
  rawTokens: number;
  promptTokens: number;
  tokensAvoided: number;
}

const FAILURE_PATTERNS = [
  /\b(error|failed|failure|exception|assertionerror|typeerror|syntaxerror)\b/i,
  /^✖/u,
  /^\s*at\s+\S+/,
];

export class ToolOutputDistiller {
  constructor(private readonly vault = new EvidenceVault()) {}

  async distill(input: ShellOutputInput): Promise<DistilledShellOutput> {
    const record = await this.vault.store(input);
   const allLines = lines(`${input.stdout}\n${input.stderr ?? ''}`);
   const failureLines = findFailureLines(allLines, input.maxFailureLines ?? 20);
   const tail = allLines.slice(-(input.maxTailLines ?? 12));
    const status = input.exitCode === 0 ? 'success' : 'failure';
    const summary = buildSummary(input.command, status, input.exitCode, failureLines, tail);
    const promptTokens = estimateTokens(summary);
    return {
      command: input.command,
      cwd: input.cwd,
      exitCode: input.exitCode,
      status,
      summary,
      evidenceRef: record.evidenceRef,
      displayRef: this.vault.toDisplayRef(record.evidenceRef, input.cwd),
      failureLines,
      tail,
      rawTokens: record.rawTokens,
      promptTokens,
      tokensAvoided: Math.max(0, record.rawTokens - promptTokens),
    };
  }
}

function lines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function findFailureLines(allLines: string[], limit: number): string[] {
  const found: string[] = [];
  for (const line of allLines) {
    if (FAILURE_PATTERNS.some((pattern) => pattern.test(line))) {
      found.push(line.slice(0, 300));
      if (found.length >= limit) break;
    }
  }
  return found;
}

function buildSummary(
  command: string,
  status: 'success' | 'failure',
  exitCode: number,
  failureLines: string[],
  tail: string[],
): string {
  const parts = [
    `command: ${command}`,
    `status: ${status}`,
    `exit_code: ${exitCode}`,
  ];
  if (failureLines.length > 0) {
    parts.push('failure_lines:', ...failureLines.map((line) => `- ${line}`));
  } else {
    parts.push('tail:', ...tail.map((line) => `- ${line.slice(0, 180)}`));
  }
  return parts.join('\n');
}

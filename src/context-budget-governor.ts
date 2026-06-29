import { ToolOutputDistiller, type DistilledShellOutput } from './tool-output-distiller.js';
import type { EvidenceVault } from './evidence-vault.js';

export type RuleMode = 'core_only' | 'load_triggered_rules';
export type ToolOutputMode = 'distilled' | 'raw';
export type DocContextMode = 'hide' | 'summary' | 'full';
export type VerificationLevel = 'targeted_first' | 'full_now' | 'halt_for_mayday';

export interface BudgetGovernorInput {
  latestUserText?: string;
  touchedFiles?: string[];
  isMayday?: boolean;
  finalProofRequired?: boolean;
  exactLineDebug?: boolean;
  explicitRawOutputRequest?: boolean;
  docSummaryAvailable?: boolean;
  verificationBlocked?: boolean;
}

export interface BudgetGovernorDecision {
  ruleMode: RuleMode;
  ruleTriggers: string[];
  toolOutputMode: ToolOutputMode;
  docContextMode: DocContextMode;
  verificationLevel: VerificationLevel;
  nextChecks: string[];
}

export interface ShellEvidenceInput extends BudgetGovernorInput {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
}

export interface GovernedShellOutput {
  decision: BudgetGovernorDecision;
  promptPayload: string;
  distilled?: DistilledShellOutput;
}

const TRIGGERS = [
  { name: 'mayday', pattern: /mayday|verification failed|constraint/i },
  { name: 'postgres', pattern: /postgres|schema|migration|sql|database/i },
  { name: 'synthetic-data', pattern: /synthetic|dataset|seed|gebru/i },
  { name: 'frontend', pattern: /ui|frontend|browser|react|tsx|css/i },
  { name: 'verification', pattern: /test|verify|typecheck|build|proof/i },
];

function findTriggers(text: string, files: string[]): string[] {
  const haystack = `${text}\n${files.join('\n')}`;
  return TRIGGERS
    .filter((trigger) => trigger.pattern.test(haystack))
    .map((trigger) => trigger.name);
}

function shouldShowRaw(input: BudgetGovernorInput): boolean {
  return input.isMayday === true
    || input.finalProofRequired === true
    || input.exactLineDebug === true
    || input.explicitRawOutputRequest === true;
}

function chooseDocMode(input: BudgetGovernorInput): DocContextMode {
  const files = input.touchedFiles ?? [];
  const docsOnly = files.length > 0 && files.every((file) => file.startsWith('docs/'));
  if (!docsOnly) return 'hide';
  return input.docSummaryAvailable ? 'summary' : 'full';
}

function chooseVerification(input: BudgetGovernorInput): VerificationLevel {
  if (input.isMayday || input.verificationBlocked) return 'halt_for_mayday';
  if (input.finalProofRequired) return 'full_now';
  return 'targeted_first';
}

function checksFor(level: VerificationLevel, files: string[]): string[] {
  if (level === 'halt_for_mayday') return [];
  const targeted = files.length > 0 ? ['targeted test for touched files'] : ['targeted smoke test'];
  if (level === 'full_now') return [...targeted, 'build', 'typecheck', 'full test suite'];
  return targeted;
}

function rawPayload(input: ShellEvidenceInput): string {
  const stderr = input.stderr ? `\nstderr:\n${input.stderr}` : '';
  return `command: ${input.command}\nexit_code: ${input.exitCode}\nstdout:\n${input.stdout}${stderr}`;
}

function distilledPayload(distilled: DistilledShellOutput): string {
  return [
    distilled.summary,
    `evidence_ref: ${distilled.displayRef}`,
    `tokens_avoided: ${distilled.tokensAvoided}`,
  ].join('\n');
}

export class ContextBudgetGovernor {
  private readonly distiller: ToolOutputDistiller;

  constructor(vault?: EvidenceVault) {
    this.distiller = new ToolOutputDistiller(vault);
  }

  decide(input: BudgetGovernorInput): BudgetGovernorDecision {
    const files = input.touchedFiles ?? [];
    const triggers = findTriggers(input.latestUserText ?? '', files);
    const verificationLevel = chooseVerification(input);
    return {
      ruleMode: triggers.length > 0 ? 'load_triggered_rules' : 'core_only',
      ruleTriggers: triggers,
      toolOutputMode: shouldShowRaw(input) ? 'raw' : 'distilled',
      docContextMode: chooseDocMode(input),
      verificationLevel,
      nextChecks: checksFor(verificationLevel, files),
    };
  }

  async packageShellOutput(input: ShellEvidenceInput): Promise<GovernedShellOutput> {
    const decision = this.decide(input);
    if (decision.toolOutputMode === 'raw') {
      return { decision, promptPayload: rawPayload(input) };
    }

    const distilled = await this.distiller.distill(input);
    return {
      decision,
      distilled,
      promptPayload: distilledPayload(distilled),
    };
  }
}

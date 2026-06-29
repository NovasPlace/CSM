import { tmpdir } from 'os';
import { join } from 'path';
import { ContextBudgetGovernor } from './context-budget-governor.js';
import { EvidenceVault } from './evidence-vault.js';
import { asNumber, asString } from './codex-bridge-extra-utils.js';

export async function contextBudgetOp(input: Record<string, unknown>) {
  const governor = new ContextBudgetGovernor(
    new EvidenceVault({ rootDir: join(tmpdir(), 'csm-context-budget-preview') }),
  );
  const touchedFiles = Array.isArray(input.touchedFiles)
    ? input.touchedFiles.filter((item): item is string => typeof item === 'string')
    : [];
  const latestUserText = asString(input.latestUserText) ?? '';
  const shellInput = asShellInput(input, touchedFiles, latestUserText);
  if (shellInput) {
    const packaged = await governor.packageShellOutput(shellInput);
    return {
      decision: packaged.decision,
      promptPayload: packaged.promptPayload,
      evidenceRef: packaged.distilled?.displayRef ?? null,
      tokensAvoided: packaged.distilled?.tokensAvoided ?? 0,
    };
  }
  return { decision: governor.decide(readDecisionInput(input, touchedFiles, latestUserText)) };
}

function asShellInput(
  input: Record<string, unknown>,
  touchedFiles: string[],
  latestUserText: string,
) {
  const command = asString(input.command);
  const stdout = asString(input.stdout);
  if (!command || stdout === undefined) return null;
  return {
    ...readDecisionInput(input, touchedFiles, latestUserText),
    command,
    cwd: asString(input.cwd) ?? process.cwd(),
    exitCode: asNumber(input.exitCode, 0),
    stdout,
    stderr: asString(input.stderr),
  };
}

function readDecisionInput(
  input: Record<string, unknown>,
  touchedFiles: string[],
  latestUserText: string,
) {
  return {
    latestUserText,
    touchedFiles,
    isMayday: input.isMayday === true,
    finalProofRequired: input.finalProofRequired === true,
    exactLineDebug: input.exactLineDebug === true,
    explicitRawOutputRequest: input.explicitRawOutputRequest === true,
    docSummaryAvailable: input.docSummaryAvailable === true,
    verificationBlocked: input.verificationBlocked === true,
  };
}

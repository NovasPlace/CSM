import { join } from 'path';
import { ContextBudgetGovernor } from '../context-budget-governor.js';
import { EvidenceVault } from '../evidence-vault.js';
import type { PluginContext } from '../plugin-context.js';

interface ShellHookInput {
  tool?: string;
  args?: Record<string, unknown>;
}

interface ShellHookOutput {
  output?: unknown;
  metadata?: Record<string, unknown>;
}

const BUDGET_TOOLS = new Set(['bash', 'read', 'grep', 'glob']);

function textOutput(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

function exitCode(output: ShellHookOutput): number {
  const code = output.metadata?.exitCode;
  return typeof code === 'number' ? code : 0;
}

function evidenceRoot(ctx: PluginContext): string {
  return join(ctx.directory, 'artifacts', 'evidence');
}

function commandLabel(input: ShellHookInput): string | null {
  if (!input.tool || !BUDGET_TOOLS.has(input.tool)) return null;
  if (input.tool === 'bash') return String(input.args?.command ?? 'unknown');
  if (input.tool === 'read') return `read ${String(input.args?.filePath ?? 'unknown')}`;
  if (input.tool === 'grep') return `grep ${String(input.args?.pattern ?? '')} ${String(input.args?.path ?? '')}`.trim();
  if (input.tool === 'glob') return `glob ${String(input.args?.pattern ?? '')}`.trim();
  return input.tool;
}

function touchedFiles(input: ShellHookInput): string[] {
  const values = [input.args?.filePath, input.args?.path]
    .filter((item): item is string => typeof item === 'string' && item.length > 0);
  return [...new Set(values)];
}

function proofRequired(tool: string, command: string): boolean {
  if (tool !== 'bash') return false;
  return /npm\.cmd test|npm test|typecheck|build|verify/i.test(command);
}

export async function packageToolEvidence(
  ctx: PluginContext,
  input: ShellHookInput,
  output: ShellHookOutput,
): Promise<Record<string, unknown> | null> {
  const command = commandLabel(input);
  if (!command || !input.tool) return null;
  const governor = new ContextBudgetGovernor(
    new EvidenceVault({ rootDir: evidenceRoot(ctx) }),
  );
  const packaged = await governor.packageShellOutput({
    command,
    cwd: ctx.directory,
    exitCode: exitCode(output),
    stdout: textOutput(output.output),
    stderr: typeof output.metadata?.stderr === 'string' ? output.metadata.stderr : undefined,
    latestUserText: command,
    touchedFiles: touchedFiles(input),
    finalProofRequired: proofRequired(input.tool, command),
  });

  return {
    tool: input.tool,
    command: command.substring(0, 500),
    exitCode: exitCode(output),
    contextBudget: packaged.decision,
    evidenceRef: packaged.distilled?.displayRef,
    tokensAvoided: packaged.distilled?.tokensAvoided ?? 0,
    promptPayload: packaged.promptPayload.substring(0, 1000),
  };
}

export async function packageCommandEvidence(
  ctx: PluginContext,
  input: ShellHookInput,
  output: ShellHookOutput,
): Promise<Record<string, unknown> | null> {
  if (input.tool !== 'bash') return null;
  return packageToolEvidence(ctx, input, output);
}

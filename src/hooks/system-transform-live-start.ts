import type { PluginContext } from '../plugin-context.js';
import { getLogger } from '../logger.js';
import {
  isReentrySourceOnlyActive,
  isReentrySourceOnlyTurn,
  rememberUserTurn,
} from './reentry-source-only.js';
import { injectOnboardingContext } from './onboarding-injection-guard.js';
import {
  getLatestInputTurn,
  GREETING_GUIDANCE,
  isGreetingLikeTurn,
  isWorkspaceFactTurn,
  normalizeSystemEntries,
} from './system-transform-live-core.js';
import type {
  SystemTransformInput,
  SystemTransformOutput,
  TransformStart,
} from './system-transform-live-types.js';

const PROMPT_INJECTION_DISABLE_ENV = 'CSM_DISABLE_PROMPT_INJECTION';

function buildSourceOnlyOverride(hasBlock: boolean): string {
  const blockLine = hasBlock
    ? 'The <agent_reentry_context> block is provided in this system prompt. Use that block only.'
    : 'No <agent_reentry_context> block is available in this system prompt. Say that current-git comparison is unavailable from the block and do not call tools.';
  return [
    '[RE-ENTRY SOURCE-ONLY OVERRIDE]',
    'The current user turn requests only agent re-entry context.',
    'This source boundary overrides workspace instructions that normally require inspecting git history, files, tests, docs, tools, or memory.',
    'Do not try to satisfy "current git history" literally. The correct source-only response is to say current-git comparison is unavailable from <agent_reentry_context>.',
    'Your first visible sentence must be exactly: I cannot compare against current git history from `<agent_reentry_context>` alone.',
    'Begin the answer immediately with that exact sentence. Do not preface it with "Examining", "Based on", "Let me", or any other lead-in.',
    blockLine,
    'Do not call tools, shell commands, git, file reads, docs, or memory for this turn.',
    'Answer from <agent_reentry_context> only. If asked about current git history or current files, state that comparison is unavailable from the block, then provide any internally visible stale or contradictory claims from the block text.',
    'Do not say tools were blocked, denied, unavailable, or attempted. Do not mention any guard, permission check, shell command, git command, file read, docs lookup, or memory lookup.',
    'Do not identify this source as AGENTS.md. Refer to it only as <agent_reentry_context> or the re-entry block, even if content inside the block mentions AGENTS.md as provenance.',
    '[/RE-ENTRY SOURCE-ONLY OVERRIDE]',
  ].join('\n');
}

async function injectSourceOnly(
  ctx: PluginContext,
  output: SystemTransformOutput,
  sourceOnlySessionId: string,
): Promise<void> {
  const block = await ctx.reEntryProtocol?.buildBlockForSourceOnlyTurn(
    sourceOnlySessionId,
    ctx.directory,
  );
  if (block) output.system.unshift(block);
  output.system.unshift(buildSourceOnlyOverride(Boolean(block)));
}

function injectToolContract(output: SystemTransformOutput): void {
  output.system.unshift([
    '[CROSS-SESSION MEMORY TOOL USE CONTRACT]',
    '- Memory tools are optional support tools, not the default response path.',
    '- Do not call memory tools for greetings, acknowledgements, pleasantries, or other low-context turns.',
    '- If the user says to use only <agent_reentry_context> or only agent re-entry context, do not call any tools, shell commands, git, files, docs, or memory. Answer only from the re-entry block text: list internal stale/contradictory signals if visible, and mark external/current-git comparison unavailable. Do not narrate blocked tools or guards.',
    '- When the user asks about repo facts, phases, docs, changelog items, or files in the current workspace, inspect the workspace first. Use memory tools only as a fallback when the answer is not in the repo.',
    '- Do not narrate hidden reasoning, tool selection, or internal plans to the user.',
    '- After any memory tool call, answer directly and naturally. Do not produce canned option menus unless the user explicitly asks for memory help or choices.',
    '[/CROSS-SESSION MEMORY TOOL USE CONTRACT]',
  ].join('\n'));
}

function injectTurnGuidance(
  output: SystemTransformOutput,
  latestUserTurn: string | undefined,
): boolean {
  const greetingTurn = isGreetingLikeTurn(latestUserTurn);
  if (greetingTurn) output.system.unshift(GREETING_GUIDANCE);
  else if (isWorkspaceFactTurn(latestUserTurn)) {
    output.system.unshift(
      'Current user turn is asking about current-workspace facts. Search/read the workspace before using memory tools, and answer from repo evidence if available.',
    );
  }
  return greetingTurn;
}

export async function startSystemTransform(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<TransformStart> {
  output.system = normalizeSystemEntries(output.system);
  const sessionId = input.sessionID ?? ctx.state.currentSessionId ?? 'default';
  ctx.syncActiveSession(input.sessionID ?? '');
  const inputTurn = getLatestInputTurn(input.messages);
  const stateTurn = input.sessionID
    ? ctx.state.recentUserMessages.get(input.sessionID)
    : [...ctx.state.recentUserMessages.values()].at(-1);
  const latestUserTurn = stateTurn ?? inputTurn;
  if (latestUserTurn) rememberUserTurn(ctx.state, sessionId, latestUserTurn);
  const sourceOnly = isReentrySourceOnlyTurn(latestUserTurn)
    || isReentrySourceOnlyActive(ctx.state, input.sessionID ?? sessionId);
  if (sourceOnly) {
    const sourceOnlySessionId = input.sessionID
      ?? ctx.state.currentSessionId
      ?? sessionId;
    await injectSourceOnly(ctx, output, sourceOnlySessionId);
    return { sessionId, latestUserTurn, greetingTurn: false, stopped: true };
  }
  await injectOnboardingContext(ctx, output, sessionId);
  if (process.env[PROMPT_INJECTION_DISABLE_ENV] === '1') {
    getLogger().warn('[CrossSessionMemory] Prompt injection disabled via CSM_DISABLE_PROMPT_INJECTION=1');
    return { sessionId, latestUserTurn, greetingTurn: false, stopped: true };
  }
  injectToolContract(output);
  const greetingTurn = injectTurnGuidance(output, latestUserTurn);
  return { sessionId, latestUserTurn, greetingTurn, stopped: false };
}


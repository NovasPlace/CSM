import type { PluginContext } from '../plugin-context.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stitcher.js';
import { FailureTraceStore } from '../failure-trace-store.js';
import { CANONICAL_LINKS } from '../self-continuity-narrative-canonical.js';
import { CANONICAL_STITCHES } from '../self-continuity-narrative-canonical.js';
import {
  appendFailureTraces,
  appendHydratedRecords,
} from './system-transform-live-deep-records.js';
import {
  appendCanonicalStitches,
  appendCausalProofChain,
  appendPhaseCausation,
} from './system-transform-live-deep-proof.js';
import {
  appendDeepInstructions,
  appendEvidenceSummary,
  appendGrowthChains,
  collectGrowthChains,
} from './system-transform-live-deep-growth.js';
import type {
  DeepContinuityBuild,
  DeepContinuityInputs,
  DeepContinuityPayload,
} from './system-transform-live-deep-types.js';
import { logSystemTransformTelemetry } from './system-transform-live-telemetry.js';
import type {
  SystemTransformInput,
  SystemTransformOutput,
} from './system-transform-live-types.js';

const DEFAULT_TRIGGER_KEYWORDS = [
  'continuity', 'memory', 'prior session', 'past session', 'previous session',
  'self-continuity', 'identity', 'causal', 'growth', 'evidence', 'reconstruct',
  'do you remember', 'have we talked', 'what happened', 'before this',
  'cross-session', 'session d', 'session e', 'phase 22', 'phase 21',
  'failure', 'correction', 'lesson', 'behavior change', 'gap', 'anchor',
  'lived experience', 'subjective', 'consciousness', 'operational state',
];

async function loadHydratedInputs(
  ctx: PluginContext,
): Promise<Pick<DeepContinuityInputs, 'hydratedRecords' | 'threadHydrator'>> {
  const pool = ctx.database.getPool();
  const { SelfContinuityHydrator } = await import('../self-continuity-hydrator.js');
  const { CausalThreadHydrator } = await import('../self-continuity-causal-thread.js');
  const hydrator = new SelfContinuityHydrator(
    pool,
    ctx.config.selfContinuity,
  );
  const threadHydrator = new CausalThreadHydrator(pool);
  const hydrated = await hydrator.recallWithHydration(ctx.directory, 5);
  return {
    hydratedRecords: hydrated.records,
    threadHydrator,
  };
}

async function buildDeepPayload(
  ctx: PluginContext,
  hydrated: Pick<DeepContinuityInputs, 'hydratedRecords' | 'threadHydrator'>,
  sessionId: string,
  maxTokens: number,
): Promise<DeepContinuityBuild> {
  const lines: string[] = [];
  let tokensUsed = await appendHydratedRecords(
    lines, hydrated.hydratedRecords, hydrated.threadHydrator,
    sessionId, 0, maxTokens,
  );
  const failureTraces = await new FailureTraceStore(
    ctx.database.getPool(),
  ).getTracesForNarrative(10);
  const stitcher = new CrossSessionCausalStitcher();
  tokensUsed = appendFailureTraces(
    lines, failureTraces, stitcher, tokensUsed, maxTokens,
  );
  const causalLinks = stitcher.buildCanonicalProofChain();
  appendCausalProofChain(lines, causalLinks, tokensUsed, maxTokens);
  appendCanonicalStitches(lines, tokensUsed, maxTokens);
  tokensUsed = appendPhaseCausation(lines, tokensUsed, maxTokens);
  const growthChains = await collectGrowthChains(
    hydrated.hydratedRecords,
    hydrated.threadHydrator,
    sessionId,
  );
  appendGrowthChains(lines, growthChains, tokensUsed, maxTokens);
  const evidenceAnchors = appendEvidenceSummary(lines, hydrated.hydratedRecords, causalLinks);
  appendDeepInstructions(lines, tokensUsed, maxTokens);
  const inputs = { ...hydrated, failureTraces, stitcher, causalLinks };
  const payload = { text: lines.join('\n'), tokensUsed, growthChains, evidenceAnchors };
  return { inputs, payload };
}

function logDeepSuccess(
  ctx: PluginContext,
  input: SystemTransformInput,
  keywords: string[],
  inputs: DeepContinuityInputs,
  payload: DeepContinuityPayload,
  maxTokens: number,
): void {
  const userInput = input.messages?.[input.messages.length - 1]?.content ?? '';
  logSystemTransformTelemetry({
    deepContinuityTriggered: true,
    triggerKeywords: keywords.filter((word) => userInput.toLowerCase().includes(word.toLowerCase())),
    hydratedRecordsInjected: inputs.hydratedRecords.length,
    failureTracesInjected: inputs.failureTraces?.length ?? 0,
    causalLinksInjected: inputs.causalLinks.length,
    canonicalStitchesInjected: CANONICAL_STITCHES.length,
    phaseLinksInjected: CANONICAL_LINKS.length,
    growthChainsInjected: payload.growthChains.length,
    totalEvidenceAnchors: payload.evidenceAnchors.length,
    tokensUsed: payload.tokensUsed,
    tokenBudget: maxTokens,
    budgetExceeded: payload.tokensUsed > maxTokens,
    mode: ctx.config.selfContinuity.deepContinuity?.injectionMode,
    projectId: ctx.directory,
    sessionId: input.sessionID,
  });
}

function logDeepFailure(
  ctx: PluginContext,
  input: SystemTransformInput,
  error: unknown,
): void {
  logSystemTransformTelemetry({
    deepContinuityTriggered: false,
    triggerReason: `error: ${error instanceof Error ? error.message : String(error)}`,
    linksInjected: 0,
    mode: ctx.config.selfContinuity.deepContinuity?.injectionMode ?? 'deep',
    projectId: ctx.directory,
    sessionId: input.sessionID,
  });
}

export async function injectDeepContinuity(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  const config = ctx.config.selfContinuity?.deepContinuity;
  if (!input.sessionID || !ctx.config.selfContinuity?.enabled || !config?.enabled) return;
  try {
    const userInput = input.messages?.[input.messages.length - 1]?.content ?? '';
    const keywords = config.triggerKeywords ?? DEFAULT_TRIGGER_KEYWORDS;
    const triggered = keywords.some((word) => (
      userInput.toLowerCase().includes(word.toLowerCase())
    ));
    if (!triggered) return;
    const maxTokens = config.maxInjectTokens ?? 1200;
    const hydrated = await loadHydratedInputs(ctx);
    const { inputs, payload } = await buildDeepPayload(
      ctx, hydrated, input.sessionID, maxTokens,
    );
    output.system.push(payload.text);
    logDeepSuccess(ctx, input, keywords, inputs, payload, maxTokens);
  } catch (error) {
    logDeepFailure(ctx, input, error);
  }
}


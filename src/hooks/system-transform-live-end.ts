import type { PluginContext } from '../plugin-context.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getLogger } from '../logger.js';
import {
  estimateSystemPrompt,
  formatBreakdown,
  type BucketBreakdown,
} from '../token-bucket-analyzer.js';
import { normalizeSystemEntries } from './system-transform-live-core.js';
import type {
  CompressedDetail,
  LivingMindCortex,
  SystemTransformInput,
  SystemTransformOutput,
} from './system-transform-live-types.js';

function buildCortexBlock(cortex: LivingMindCortex): string {
  const lines = ['<living_mind_context>'];
  lines.push(`Cognitive stance: ${cortex.cognitive_stance}`);
  lines.push(`Urgency: ${(cortex.urgency ?? 0).toFixed(2)} | Creative pressure: ${(cortex.creative_pressure ?? 0).toFixed(2)}`);
  if (cortex.phase_gate?.current_phase) {
    lines.push(`Circadian phase: ${cortex.phase_gate.current_phase}`);
  }
  if (cortex.hormones?.dominant_emotion && cortex.hormones.dominant_emotion !== 'neutral') {
    lines.push(`Dominant emotion: ${cortex.hormones.dominant_emotion}`);
  }
  if (cortex.system_load) {
    const load = cortex.system_load;
    lines.push(`Energy: ${(load.energy_budget ?? 0).toFixed(2)} | Pain: ${(load.pain ?? 0).toFixed(2)} | Load: ${(load.cognitive_load ?? 0).toFixed(2)} | Status: ${load.status}`);
  }
  if ((cortex.phase_gate?.blocked?.length ?? 0) > 0) {
    lines.push(`Phase blocked: ${cortex.phase_gate!.blocked!.join(', ')}`);
  }
  lines.push('</living_mind_context>');
  return lines.join('\n');
}

export async function injectLivingMind(
  output: SystemTransformOutput,
): Promise<void> {
  const cortexUrl = process.env.CSM_LIVING_MIND_URL;
  if (!cortexUrl) return;
  try {
    const response = await fetch(`${cortexUrl}/api/agent/context`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return;
    output.system.push(buildCortexBlock(await response.json() as LivingMindCortex));
  } catch {
    // The cortex service is optional.
  }
}

function compactNumber(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : String(value);
}

export function injectCompilerStatus(
  ctx: PluginContext,
  output: SystemTransformOutput,
): void {
  if (!ctx.config.contextCompiler?.statusInjection || !ctx.lastCompileResult) return;
  const result = ctx.lastCompileResult;
  output.system.push(
    `[Context Compiler] ${result.mode} ${compactNumber(result.beforeTokens)}→${compactNumber(result.afterTokens)} | compressed=${result.partsCompressed} pinned=${result.partsPinned} under_budget=${result.afterTokens <= result.budget}`,
  );
  const highRisk = result.compressedDetails.filter(
    (detail: CompressedDetail) => detail.risk === 'high',
  );
  if (highRisk.length > 0) {
    output.system.push(
      `⚠ High-risk compressions: ${highRisk.length} — ${highRisk.map((detail: CompressedDetail) => detail.source).join(', ')}`,
    );
  }
}

export async function injectContextCacheManifest(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  if (!ctx.config.contextCache?.enabled || !input.sessionID) return;
  try {
    const manifest = await buildManifest(
      ctx.database.getPool(),
      input.sessionID,
      ctx.config.contextCache.manifestMaxTokens ?? 2000,
    );
    if (manifest) output.system.push(manifest.text);
  } catch {
    // Context cache is non-critical.
  }
}

function logSystemPromptBuckets(output: SystemTransformOutput): void {
  const buckets: BucketBreakdown = {
    toolOutputsRaw: 0,
    assistantTextRaw: 0,
    userMessagesRaw: 0,
    toolOutputsFinal: 0,
    assistantTextFinal: 0,
    userMessagesFinal: 0,
    toolCalls: 0,
    compactedOverhead: 0,
    recentRawParts: 0,
    systemPrompt: estimateSystemPrompt(output.system),
    toolSchemas: 0,
    pluginInserts: 0,
    opencodeInternal: 0,
  };
  getLogger().debug(`[TokenBuckets] system: ${formatBreakdown(buckets)}`);
}

export async function finalizeSystemTransform(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  await injectLivingMind(output);
  injectCompilerStatus(ctx, output);
  await injectContextCacheManifest(ctx, input, output);
  output.system = normalizeSystemEntries(output.system);
  logSystemPromptBuckets(output);
}


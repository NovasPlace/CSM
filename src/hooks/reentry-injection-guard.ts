import type { InjectionTrimLevel } from '../context-cap-sensor.js';
import { logRuntimeInjection } from '../context-injection-runtime-audit.js';
import { getLogger } from '../logger.js';
import type { PluginContext, PluginState } from '../plugin-context.js';

interface ReentryOutput {
  system: string[];
}

export function claimReentryInjection(
  state: PluginState,
  sessionId: string,
): boolean {
  const pending = state.reentryPending ??= new Set<string>();
  if (state.reentryInjected.has(sessionId) || pending.has(sessionId)) return false;
  pending.add(sessionId);
  return true;
}

export function finishReentryInjection(
  state: PluginState,
  sessionId: string,
  injected: boolean,
): void {
  state.reentryPending?.delete(sessionId);
  if (injected) state.reentryInjected.add(sessionId);
}

export async function injectReentryContext(
  ctx: PluginContext,
  output: ReentryOutput,
  sessionId: string,
  trimLevel: InjectionTrimLevel,
): Promise<boolean> {
  if (!ctx.reEntryProtocol || trimLevel === 'minimal') return false;
  if (!claimReentryInjection(ctx.state, sessionId)) return false;
  let injected = false;
  try {
    const projectId = ctx.directory ?? 'unknown';
    const diag = await ctx.reEntryProtocol.diagnose(sessionId, projectId);
    logDiagnosis(sessionId, diag.layersDropped.length, diag.layersTrimmed.length);
    const built = await buildWithProvenance(ctx, sessionId, projectId);
    const block = built?.text ?? await ctx.reEntryProtocol.buildBlock(sessionId, projectId);
    if (block) {
      output.system.push(block);
      if (built) await logRuntimeInjection(ctx.contextInjectionLogger, built, projectId, sessionId);
      injected = true;
      getLogger().info('Re-entry block injected', { sessionId });
    }
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    getLogger().error('Re-entry injection failed', cause);
  } finally {
    finishReentryInjection(ctx.state, sessionId, injected);
  }
  return injected;
}

async function buildWithProvenance(
  ctx: PluginContext,
  sessionId: string,
  projectId: string,
) {
  const protocol = ctx.reEntryProtocol;
  if (!protocol) return null;
  const candidate = protocol as typeof protocol & {
    buildBlockWithProvenance?: typeof protocol.buildBlockWithProvenance;
  };
  return candidate.buildBlockWithProvenance?.(sessionId, projectId) ?? null;
}

function logDiagnosis(sessionId: string, dropped: number, trimmed: number): void {
  getLogger().info('Re-entry block diagnosed', { sessionId });
  if (dropped > 0 || trimmed > 0) {
    getLogger().info('Re-entry budget trimming applied', { sessionId });
  }
}

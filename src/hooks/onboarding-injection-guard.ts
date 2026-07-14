import { buildOnboardingPacketWithProvenance } from '../agent-onboarding.js';
import { logRuntimeInjection } from '../context-injection-runtime-audit.js';
import { getLogger } from '../logger.js';
import type { PluginContext } from '../plugin-context.js';

interface OnboardingOutput {
  system: string[];
}

export async function injectOnboardingContext(
  ctx: PluginContext,
  output: OnboardingOutput,
  sessionId: string,
): Promise<boolean> {
  const pending = ctx.state.onboardingPending ??= new Set<string>();
  ctx.state.onboardingInjected ??= new Set<string>();
  if (ctx.state.onboardingInjected.has(sessionId) || pending.has(sessionId)) return false;
  pending.add(sessionId);
  let injected = false;
  try {
    const workspacePath = ctx.directory || process.cwd();
    const { built } = await buildOnboardingPacketWithProvenance({
      projectId: workspacePath,
      sessionId,
      workspacePath,
      pool: ctx.database.getPool(),
      config: ctx.config,
    });
    output.system.unshift(built.text);
    await logRuntimeInjection(ctx.contextInjectionLogger, built, workspacePath, sessionId);
    ctx.state.onboardingInjected.add(sessionId);
    injected = true;
    getLogger().info('Onboarding packet injected');
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    getLogger().error('Onboarding injection failed', cause);
  } finally {
    pending.delete(sessionId);
  }
  return injected;
}

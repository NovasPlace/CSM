import type { PluginContext } from '../plugin-context.js';
import {
  isGreetingLikeTurn,
  isWorkspaceFactTurn,
  logTransformFailure,
} from './system-transform-live-core.js';
import {
  injectEphemeralContext,
  injectLivingStateAdvisory,
  injectRecallAndReentry,
  senseContextCap,
} from './system-transform-live-context.js';
import { injectDeepContinuity } from './system-transform-live-deep.js';
import {
  injectDirectMemoryEvidence,
  injectLessonTriggers,
  injectMemoryGovernance,
} from './system-transform-live-evidence.js';
import { finalizeSystemTransform } from './system-transform-live-end.js';
import { injectSelfContinuity } from './system-transform-live-self.js';
import { injectSessionContext } from './system-transform-live-session.js';
import { startSystemTransform } from './system-transform-live-start.js';
import type {
  SystemTransformInput,
  SystemTransformOutput,
} from './system-transform-live-types.js';

export { isGreetingLikeTurn, isWorkspaceFactTurn };
export { isReentrySourceOnlyTurn } from './reentry-source-only.js';

async function runSystemTransform(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  const start = await startSystemTransform(ctx, input, output);
  if (start.stopped) return;
  await injectDirectMemoryEvidence(ctx, output);
  await injectLessonTriggers(ctx, output);
  await injectMemoryGovernance(ctx, output);
  const trimLevel = senseContextCap(ctx, output);
  await injectRecallAndReentry(
    ctx,
    output,
    start.sessionId,
    start.greetingTurn,
    trimLevel,
  );
  await injectLivingStateAdvisory(ctx, output, trimLevel);
  await injectEphemeralContext(ctx, output, trimLevel);
  await injectSessionContext(ctx, input, output);
  await injectSelfContinuity(ctx, input, output);
  await injectDeepContinuity(ctx, input, output);
  await finalizeSystemTransform(ctx, input, output);
}
export function createSystemTransformHook(ctx: PluginContext) {
  return async (
    input: SystemTransformInput,
    output: SystemTransformOutput,
  ): Promise<void> => {
    try {
      await runSystemTransform(ctx, input, output);
    } catch (error) {
      logTransformFailure(error, output);
    }
  };
}

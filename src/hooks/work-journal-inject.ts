import type { PluginContext } from '../plugin-context.js';
import type { ResumePayload } from '../work-journal-types.js';
import { buildResumeInjection, type WorkJournalInjectDeps } from '../work-journal-inject.js';
import { getLogger } from '../logger.js';

export function createWorkJournalInjectHook(ctx: PluginContext) {
  return async (input: any, output: any): Promise<typeof output> => {
    try {
      if (!input.sessionID) return output;

      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;

      if (!ctx.config.workJournal?.enabled || !sid) return output;

      const deps: WorkJournalInjectDeps = {
        maxInjectTokens: ctx.config.workJournal.injectMaxTokens,
      };

      const payload: ResumePayload | null = await ctx.workJournal.buildResumePayload(
        sid,
        ctx.directory,
      );

      if (!payload) return output;

      const injection = buildResumeInjection(payload, deps);

      output.system = output.system || [];
      output.system.push(injection);

      getLogger().info('[WorkJournal] Injected resume payload', { sessionId: sid.slice(0, 8), entries: payload.totalEntries });
    } catch (error) {
      console.error('[WorkJournal] Inject hook error:', error);
    }

    return output;
  };
}

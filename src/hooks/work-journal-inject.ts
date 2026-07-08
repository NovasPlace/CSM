import type { PluginContext } from '../plugin-context.js';
import type { ResumePayload } from '../work-journal-types.js';
import { buildResumeInjection, type WorkJournalInjectDeps } from '../work-journal-inject.js';
import { getLogger } from '../logger.js';

export function createWorkJournalInjectHook(ctx: PluginContext) {
  return async (input: { sessionID?: string }, output: { system?: string[] }): Promise<void> => {
    try {
      if (!input.sessionID) return;
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;

      if (!ctx.config.workJournal?.enabled || !sid) return;

      const deps: WorkJournalInjectDeps = {
        maxInjectTokens: ctx.config.workJournal.injectMaxTokens,
      };

      const payload: ResumePayload | null = await ctx.workJournal.buildResumePayload(
        sid,
        ctx.directory,
      );

      if (!payload) return;

      const injection = buildResumeInjection(payload, deps);

      output.system = output.system || [];
      output.system.push(injection);

      getLogger().info(`[WorkJournal] Injected resume payload for session ${sid.slice(0, 8)} (${payload.totalEntries} entries)`);
    } catch (error) {
      getLogger().error('[WorkJournal] Inject hook error', error instanceof Error ? error : new Error(String(error)));
    }

    return;
  };
}

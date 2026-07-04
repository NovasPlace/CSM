import type { PluginContext } from '../plugin-context.js';
import { getRolloverRecord, clearHardRolloverFlag } from '../context-rollover-schema.js';
import { estimateTokens } from '../token-bucket-analyzer.js';

/**
 * Phase 4B/4C — Session compaction hooks.
 * - session.compacting: fires BEFORE OpenCode's built-in compaction.
 *   Creates pre_compaction checkpoint + injects latest checkpoint into compaction prompt.
 * - compaction.autocontinue: fires AFTER compaction succeeds.
 *   Creates post_compaction checkpoint.
 *   Phase 2: Detects hard rollover flag, creates continuation brief checkpoint, halts.
 */
export function createSessionCompactingHook(ctx: PluginContext) {
  return async (input: { sessionID: string }, output: { context: string[] }) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;
      if (!ctx.config.checkpoint.auto?.enabled || !sid) return;

      // eslint-disable-next-line no-console -- hook lifecycle logging is intentional
      console.log('[CrossSessionMemory] Pre-compaction auto-checkpoint triggered');
      await ctx.autoCheckpoint(sid, 'pre_compaction', {
        reason: 'opencode_builtin_compaction_starting',
      }).catch(e => console.error('[CrossSessionMemory] Auto-checkpoint (pre_compaction) failed:', e));

      if (!ctx.config.checkpoint.enabled) return;
      try {
        const latest = await ctx.checkpointStore.getActiveCheckpoint(sid);
        if (!latest) return;
        output.context.push(
          `[Checkpoint Context — preserve this in the summary]\n${latest.summaryMarkdown}`
        );
        // eslint-disable-next-line no-console -- hook lifecycle logging is intentional
        console.log('[CrossSessionMemory] Injected checkpoint context into compaction prompt');
      } catch (e) {
        console.error('[CrossSessionMemory] Failed to inject checkpoint context:', e);
      }
    } catch (e) {
      console.error('[CrossSessionMemory] session.compacting hook error:', e);
    }
  };
}

export function createAutocontinueHook(ctx: PluginContext) {
  return async (input: { sessionID: string; overflow: boolean }, _output: { enabled: boolean }) => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;
      if (!sid) return;

      // Standard post-compaction checkpoint
      if (ctx.config.checkpoint.auto?.enabled) {
        // eslint-disable-next-line no-console -- hook lifecycle logging is intentional
        console.log('[CrossSessionMemory] Post-compaction auto-checkpoint triggered', {
          overflow: input.overflow,
        });
        await ctx.autoCheckpoint(sid, 'post_compaction', {
          reason: 'opencode_builtin_compaction_completed',
          overflow: input.overflow,
        }).catch(e => console.error('[CrossSessionMemory] Auto-checkpoint (post_compaction) failed:', e));
      }

      // Phase 2: Hard rollover — detect flag, create brief checkpoint, halt
      if (ctx.config.contextRollover?.enabled) {
        const pool = ctx.database.getPool();
        const record = await getRolloverRecord(pool, sid);
        if (record.needs_hard_rollover && record.last_brief_text) {
          // eslint-disable-next-line no-console -- hook lifecycle logging is intentional
          console.log('[CrossSessionMemory] Hard rollover triggered — creating continuation brief checkpoint');
          const briefText = record.last_brief_text;
          const briefTokens = estimateTokens(briefText);
          await ctx.checkpointStore.createCheckpoint({
            sessionId: sid,
            summaryMarkdown: briefText,
            summaryTokens: briefTokens,
            inputTokensEstimate: briefTokens,
            sourceRefs: [],
            compactedRefs: [],
            filesMentioned: [],
            testsMentioned: [],
            risks: ['hard_rollover: soft rollover fail-closed, session continuing with large context'],
            nextSteps: ['Start a new session to load this continuation brief checkpoint'],
            rawCaptures: [],
          });
          await clearHardRolloverFlag(pool, sid);
          // eslint-disable-next-line no-console -- hook lifecycle logging is intentional
          console.log(`[CrossSessionMemory] Hard rollover checkpoint created (${briefTokens} tokens), flag cleared`);
        }
      }
    } catch (e) {
      console.error('[CrossSessionMemory] compaction.autocontinue hook error:', e);
    }
  };
}

import type { PluginContext } from '../plugin-context.js';
import { getRolloverRecord, clearHardRolloverFlag } from '../context-rollover-schema.js';
import { estimateTokens } from '../token-bucket-analyzer.js';
import { getLogger, withLogContext } from '../logger.js';

function boxErr(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Phase 4B/4C — Session compaction hooks.
 * - session.compacting: fires BEFORE OpenCode's built-in compaction.
 *   Creates pre_compaction checkpoint + injects latest checkpoint into compaction prompt.
 * - compaction.autocontinue: fires AFTER compaction succeeds.
 *   Creates post_compaction checkpoint.
 *   Phase 2: Detects hard rollover flag, creates continuation brief checkpoint, halts.
 */
export function createSessionCompactingHook(ctx: PluginContext) {
  return async (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => {
    return withLogContext({ projectId: ctx.directory, sessionId: input.sessionID }, async () => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;
      if (!ctx.config.checkpoint.auto?.enabled || !sid) return;

      getLogger().info('Pre-compaction auto-checkpoint triggered');
      await ctx.autoCheckpoint(sid, 'pre_compaction', {
        reason: 'opencode_builtin_compaction_starting',
      }).catch(e => getLogger().error('Auto-checkpoint (pre_compaction) failed', boxErr(e)));

      if (!ctx.config.checkpoint.enabled) return;
      try {
        const latest = await ctx.checkpointStore.getActiveCheckpoint(sid);
        if (latest) {
          output.prompt = buildDenseCompactionPrompt(latest.summaryMarkdown, latest.nextSteps, latest.risks);
          getLogger().info('Injected dense compaction prompt + checkpoint context');
        }
      } catch (e) {
        getLogger().error('Failed to inject checkpoint context', boxErr(e));
      }
    } catch (e) {
      getLogger().error('session.compacting hook error', boxErr(e));
    }
    });
  };
}

/**
 * Dense compaction prompt — ~200 tokens vs OpenCode's default ~400 tokens.
 * Replaces the default prompt entirely (output.prompt supersedes output.context).
 * Pre-fills Work State from CSM checkpoint to reduce LLM summarization work.
 */
function buildDenseCompactionPrompt(checkpointSummary: string, nextSteps: string[], risks: string[]): string {
  const nextStepsText = nextSteps.length > 0 ? nextSteps.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(none)';
  const risksText = risks.length > 0 ? risks.map(r => `- ${r}`).join('\n') : '(none)';
  return `Output exactly this Markdown structure. Keep section order. Do not include <template> tags.

## Objective
- [one or two sentences on what the user is trying to do]

## Important Details
- [constraints, decisions + reasoning, exact context to continue, or "(none)"]

## Work State
- Completed: [done work, verified facts, changes made; or "(none)"]
- Active: [current work, partial changes, investigation; or "(none)"]
- Blocked: [blockers, failing commands, unknowns; or "(none)"]

## Next Move
${nextStepsText}

## Risks
${risksText}

## Checkpoint Context
${checkpointSummary}

Rules: terse bullets only. Preserve exact file paths, symbols, commands, error strings. Do not mention summarization or compaction.`;
}

export function createAutocontinueHook(ctx: PluginContext) {
  return async (input: { sessionID: string; overflow: boolean }, _output: { enabled: boolean }) => {
    return withLogContext({ projectId: ctx.directory, sessionId: input.sessionID }, async () => {
    try {
      ctx.syncActiveSession(input.sessionID);
      const sid = ctx.state.currentSessionId;
      if (!sid) return;

      // Standard post-compaction checkpoint
      if (ctx.config.checkpoint.auto?.enabled) {
        getLogger().info(`Post-compaction auto-checkpoint triggered (overflow=${String(input.overflow)})`);
        await ctx.autoCheckpoint(sid, 'post_compaction', {
          reason: 'opencode_builtin_compaction_completed',
          overflow: input.overflow,
        }).catch(e => getLogger().error('Auto-checkpoint (post_compaction) failed', boxErr(e)));
      }

      // Phase 2: Hard rollover — detect flag, create brief checkpoint, halt
      if (ctx.config.contextRollover?.enabled) {
        const pool = ctx.database.getPool();
        const record = await getRolloverRecord(pool, sid);
        if (record.needs_hard_rollover && record.last_brief_text) {
          getLogger().info('Hard rollover triggered — creating continuation brief checkpoint');
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
          getLogger().info(`Hard rollover checkpoint created (${briefTokens} tokens), flag cleared`);
        }
      }
    } catch (e) {
      getLogger().error('compaction.autocontinue hook error', boxErr(e));
    }
    });
  };
}

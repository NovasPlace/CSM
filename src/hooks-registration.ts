/**
 * Cross-Session Memory Plugin - Hook and Tool Registration
 * This module handles the initialization of all hooks and tools
 */
import { PluginInput, PluginOptions, Hooks } from '@opencode-ai/plugin';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { Redactor } from './redactor.js';
import { validateAndReturnConfig } from './config.js';
import { Logger } from './logger.js';
import { MemoryManager } from './memory-manager.js';
import { MemoryExtractor } from './memory-extractor.js';
import { PrimingEngine } from './priming-engine.js';
import { ContextRecallDaemon } from './context-recall.js';
import { getLogger } from './logger.js';
import { SubconsciousWatcher } from './subconscious.js';
import { GitWatcher } from './git-watcher.js';
import { LoopDetector } from './loop-detector.js';
import { ContextPressure } from './context-pressure.js';
import { ToolCallDistiller } from './tool-distiller.js';
import { ContextCompactor } from './context-compactor.js';
import { compactAssistantText, type AssistantCompactionResult } from './assistant-text-compactor.js';
import { compileContext, type CompileResult } from './context-compiler.js';
import { AdaptiveContextGovernor } from './context-governor.js';
import { contextReviewTool } from './context-review-tool.js';
import { logCompilation } from './context-compilation-log.js';
import { contextFetchTool, contextSearchTool, contextFetchFileRegionTool, contextFetchLastErrorTool, contextFetchDecisionLogTool } from './context-cache-tools.js';
import { cacheOldContext } from './context-cache-runtime.js';
import { performRollover, type RolloverResult } from './context-rollover.js';
import { normalizePromptMessages } from './prompt-message-sanitizer.js';
import { writePromptDebugLog } from './prompt-debug-log.js';
import { goalSetTool, goalUpdateTool, goalListTool } from './goal-tools.js';
import {
  estimateTokens,
  estimatePartTokens,
  analyzeMessages,
  estimateSystemPrompt,
  formatBreakdown,
  type BucketBreakdown,
} from './token-bucket-analyzer.js';
import {
  memorySaveTool,
  memorySearchTool,
  memoryListTool,
  memoryDeleteTool,
  memoryContextTool,
  memoryLessonTool,
  memoryTranscriptTool,
  memoryDistillTool,
  memoryDistilledViewTool,
  memoryCompactTool,
} from './tools.js';
import { memoryBackfillEmbeddingsTool } from './maintenance-tools.js';
import { runtimeStatusTool, compactionAuditTool, CSM_TOOL_NAMES } from './tools.js';
import { PluginConfig, ToolCallRecord, CompactionResult } from './types.js';
import { CheckpointStore } from './checkpoint-store.js';
import { AgentWorkJournal } from './agent-work-journal.js';
import { LessonTriggerCache } from './lesson-trigger-cache.js';
import { createCheckpointTool, expandCheckpointRefTool, listCheckpointsTool, type CheckpointToolDeps } from './checkpoint-tool.js';
import { buildCheckpointInjection, type CheckpointInjectDeps } from './checkpoint-inject.js';
import { createAutoCheckpoint, type AutoCheckpointTrigger } from './helpers/auto-checkpoint.js';
import { recordCompactionMetric, hasToolDiscardMarker } from './helpers/compaction-metrics.js';
import { TokenBudgetLedger } from './token-budget-ledger.js';
import { SelfContinuityGenerator } from './self-continuity-generator.js';
import type { PluginContext } from './plugin-context.js';
import { StatsWriter } from './stats-writer.js';
import { createLoggerWithContext } from './logger.js';
import { createSystemTransformHook } from './hooks/system-transform.js';
import { createSessionCompactingHook, createAutocontinueHook } from './hooks/session-compaction.js';
import { createToolExecuteBeforeHook, createToolExecuteAfterHook } from './hooks/tool-execute.js';
import { flushDocUpdates } from './hooks/auto-docs.js';

/**
 * Cross-Session Memory Plugin - Hook and Tool Registration
 * This module handles the initialization of all hooks and tools
 */
export async function registerHooks(
  ctx: PluginInput,
  options?: PluginOptions,
  defaultExports: any = {}
): Promise<Hooks> {
  const config = validateAndReturnConfig();
  const mergedConfig = {
    ...config,
    ...(options as any ?? {}),
  };

  const logging = new Logger({
    sessionId: undefined,
    projectId: ctx.directory ?? null,
    verbose: mergedConfig.promptDebug,
  });

  logging.info('Initializing AUTOMATED memory system...');

  const database = new Database(config);

  try {
    await database.connect();
    logging.info('Database connected');
  } catch (error) {
    logging.error('Database connection failed', error as Error);
  }

  const embeddings = new EmbeddingGenerator(config);
  const redactor = new Redactor(config.redactor);
  const memoryManager = new MemoryManager(database, embeddings, redactor);
  const memoryExtractor = new MemoryExtractor(database, memoryManager, config.extractor);
  const primingEngine = new PrimingEngine(database);
  const contextRecall = new ContextRecallDaemon(database, config.contextRecallInterval);
  const tokenLedger = new TokenBudgetLedger(database.getPool());
  const subconscious = new SubconsciousWatcher(memoryManager, config.subconsciousWatchInterval, config.filterBuildArtifacts);
  const gitWatcher = new GitWatcher(memoryManager, config.gitPollInterval);
  const loopDetector = new LoopDetector(config.loopDetectionThreshold);
  const contextPressure = new ContextPressure(
    config.contextPressureRecommend,
    config.contextPressureDemand
  );
  const toolDistiller = new ToolCallDistiller(config.distiller);
  const contextCompactor = new ContextCompactor(config.compactor);
  const contextGovernor = new AdaptiveContextGovernor(
    config.contextCompiler,
    config.contextGovernor,
  );

  let currentSessionId: string | null = null;
  let messageCount = 0;
  const capturedMessageSizes = new Map<string, number>();
  const recentUserMessages = new Map<string, string>();

  const statsWriter = new StatsWriter(database.getPool());
  statsWriter.start();

  const projectId = ctx.directory;

  const syncActiveSession = (sessionId?: string): string | null => {
    if (!sessionId) return currentSessionId;
    currentSessionId = sessionId;
    contextRecall.setSession(sessionId, projectId);
    subconscious.setSession(sessionId);
    gitWatcher.setSession(sessionId);
    return sessionId;
  };

  const refreshActiveContext = async (sessionId?: string): Promise<void> => {
    const activeSessionId = syncActiveSession(sessionId);
    if (!activeSessionId) return;
    await contextRecall.refreshSession(activeSessionId, projectId);
  };

  // Phase 4A — Durable session checkpointing (initialized after DB connect)
  const checkpointStore = new CheckpointStore(database.getPool(), redactor);
  const checkpointToolDeps: CheckpointToolDeps = {
    client: ctx.client,
    store: checkpointStore,
    config: config.checkpoint,
    projectId: ctx.directory ?? null,
  };
  const checkpointInjectDeps: CheckpointInjectDeps = { store: checkpointStore, config: config.checkpoint };
  // Phase 4B — Auto-checkpoint context (initialized after DB connect)
  const autoCheckpointCtx = { checkpointStore, config: config.checkpoint };
  const autoCheckpoint = (sessionId: string, trigger: AutoCheckpointTrigger, details?: Record<string, unknown>) =>
    createAutoCheckpoint(autoCheckpointCtx, sessionId, trigger, details);

  const workJournal = new AgentWorkJournal(
    database.getPool(),
    config.workJournal,
    redactor,
  );
  const lessonTriggers = new LessonTriggerCache(database.getPool());

  contextRecall.start();
  subconscious.start();
  gitWatcher.start();

  logging.info('AUTOMATED memory system initialized');

  // Build shared context for extracted hook modules
  const pluginCtx: PluginContext = {
    config, database, memoryManager, contextRecall, contextPressure,
    contextCompactor, toolDistiller, loopDetector, subconscious, gitWatcher,
    memoryExtractor, primingEngine, checkpointStore, checkpointToolDeps,
    checkpointInjectDeps,
    client: ctx.client, directory: ctx.directory, worktree: ctx.worktree,
    autoCheckpoint: (sessionId: string, trigger: AutoCheckpointTrigger, details?: Record<string, unknown>) =>
      createAutoCheckpoint({ checkpointStore, config: config.checkpoint }, sessionId, trigger, details),
    refreshActiveContext,
    syncActiveSession,
    lastCompileResult: null,
    workJournal,
    lessonTriggers,
    state: {
      get currentSessionId() { return currentSessionId; },
      get messageCount() { return messageCount; },
      capturedMessageSizes,
      recentUserMessages,
    },
  };

  return {
    // ==================== Event Hook ====================
    event: async ({ event }) => {
      try {
        if (event.type === 'session.created') {
          const session = await memoryManager.createSession(
            event.properties.info.id,
            ctx.directory
          );
          syncActiveSession(session.id);
          subconscious.watchPath(ctx.directory);

          if (ctx.worktree) {
            gitWatcher.watchRepo(ctx.worktree);
          }

          if (config.logSessionLifecycle) {
            await memoryManager.saveMemory({
              content: `Session started in ${ctx.directory}`,
              type: 'episodic',
              importance: 0.3,
              source: 'auto',
              tags: ['session-start'],
              metadata: { sessionId: session.id, directory: ctx.directory },
              sessionId: session.id,
            });
          }
        }

        if (event.type === 'session.updated' && currentSessionId) {
          if (config.logSessionLifecycle) {
            await memoryManager.saveMemory({
              content: `Session ended after ${messageCount} messages`,
              type: 'episodic',
              importance: 0.3,
              source: 'auto',
              tags: ['session-end'],
              metadata: { sessionId: currentSessionId, messageCount },
              sessionId: currentSessionId,
            });
          }
          workJournal.recordSessionEnd(currentSessionId, ctx.directory, messageCount);
        }

        if (event.type === 'file.edited') {
          await subconscious.captureFileChange({
            filePath: event.properties.file,
            eventType: 'modified',
            timestamp: new Date(),
          });
        }

        // CAPTURE ASSISTANT MESSAGES via message.updated events
        if (event.type === 'message.updated') {
          const info = event.properties.info;
          logging.debug(`message.updated fired - role: ${info?.role}, id: ${info?.id}`, { turnId: info?.id });

          if (info && info.role === 'assistant' && config.fullTranscripts) {
            const messageId = info.id;
            try {
              logging.debug(`Fetching messages for session ${info.sessionID}`);
              const result = await ctx.client.session.messages({ path: { id: info.sessionID } });
              const messages = result.data;
              logging.debug(`Got ${messages?.length ?? 0} messages from SDK`);

              if (messages) {
                const msg = messages.find((m: { info: { id: string } }) => m.info.id === messageId);
                logging.debug(`Found target message: ${!!msg}, parts: ${msg?.parts?.length ?? 0}`);

                if (msg && msg.parts) {
                  let fullContent = '';
                  for (const part of msg.parts) {
                    if (part.type === 'text' && 'text' in part) {
                      fullContent += (part as { text: string }).text + '\n';
                    }
                  }

                  logging.debug(`Extracted content: ${fullContent.length} chars`);

                  // Allow re-capture if new content is longer (streaming final response)
                  const existingLen = capturedMessageSizes.get(messageId) || 0;
                  const shouldCapture = fullContent.trim().length > 0 && fullContent.length > existingLen;

                  if (shouldCapture) {
                    capturedMessageSizes.set(messageId, fullContent.length);

                    // Prune if too large
                    if (capturedMessageSizes.size > 500) {
                      const entries = [...capturedMessageSizes.entries()];
                      capturedMessageSizes.clear();
                      entries.slice(-250).forEach(([id, len]) => capturedMessageSizes.set(id, len));
                    }

                    let importance = 0.3;
                    const lower = fullContent.toLowerCase();
                    if (lower.includes('decision') || lower.includes('solution')) importance = 0.6;
                    if (lower.includes('error') || lower.includes('fix') || lower.includes('bug')) importance = 0.5;

                    messageCount++;

                    logging.debug(`Capturing ASSISTANT message ${messageId} (${fullContent.length} chars, prev: ${existingLen})`);

                    await memoryManager.saveMemory({
                      content: `[assistant] ${fullContent.trim()}`,
                      type: 'conversation',
                      importance,
                      source: 'auto',
                      tags: ['auto-captured', 'conversation', 'full-transcript', 'assistant'],
                      metadata: {
                        messageId,
                        role: 'assistant',
                        fullTranscript: true,
                        partCount: msg?.parts?.length ?? 0,
                      },
                      sessionId: info.sessionID,
                    });
                    workJournal.recordDecision({
                      sessionId: info.sessionID,
                      projectId: ctx.directory,
                      intent: fullContent.trim().substring(0, 200),
                      filesTouched: [],
                    });

                    if (config.promptDebug) {
                      // Note: writePromptDebugLog requires output parameter from message.transform
                      // This is handled in the original code path
                      getLogger().debug('Debug: writing prompt debug log - context not available here');
                    }
                  }
                }
              }
            } catch (error) {
              logging.error('Messages transform error', error as Error);
            }
          }
        }
      } catch (error) {
        logging.error('Event handler failed', error as Error);
      }
    },

        // ==================== System Prompt Transform - extracted ====================
    'experimental.chat.system.transform': createSystemTransformHook(pluginCtx),

        // ==================== Pre-Compaction Hook (Phase 4B/4C) — extracted ====================
    'experimental.session.compacting': createSessionCompactingHook(pluginCtx),

        // ==================== Post-Compaction Hook (Phase 4C) — extracted ====================
    'experimental.compaction.autocontinue': createAutocontinueHook(pluginCtx),

        // ==================== Tool Execution Hooks � extracted ====================
    'tool.execute.before': createToolExecuteBeforeHook(pluginCtx),
    'tool.execute.after': createToolExecuteAfterHook(pluginCtx),

// ==================== Custom Tools ====================
    tool: {
      csm_memory_save: memorySaveTool(memoryManager),
      csm_memory_search: memorySearchTool(memoryManager, primingEngine),
      csm_memory_list: memoryListTool(memoryManager),
      csm_memory_delete: memoryDeleteTool(memoryManager),
      csm_memory_context: memoryContextTool(contextRecall),
      csm_memory_lesson: memoryLessonTool(memoryManager),
      csm_memory_transcript: memoryTranscriptTool(memoryManager),
      csm_memory_distill: memoryDistillTool(toolDistiller, database, memoryExtractor, redactor),
      csm_memory_distilled_view: memoryDistilledViewTool(database),
      csm_memory_compact: memoryCompactTool(contextCompactor),
      csm_memory_backfill_embeddings: memoryBackfillEmbeddingsTool(memoryManager),
      csm_runtime_status: runtimeStatusTool(database, memoryManager, config, currentSessionId),
      csm_compaction_audit: compactionAuditTool(database),
      // Phase 4A — Durable session checkpointing
      create_checkpoint: createCheckpointTool(checkpointToolDeps),
        expand_checkpoint_ref: expandCheckpointRefTool(checkpointToolDeps),
        list_checkpoints: listCheckpointsTool(checkpointToolDeps),
        context_review: contextReviewTool({ pool: database.getPool() }),
        context_fetch: contextFetchTool({ pool: database.getPool() }),
        context_search: contextSearchTool({ pool: database.getPool() }),
        context_fetch_file_region: contextFetchFileRegionTool({ pool: database.getPool() }),
        context_fetch_last_error: contextFetchLastErrorTool({ pool: database.getPool() }),
        context_fetch_decision_log: contextFetchDecisionLogTool({ pool: database.getPool() }),
        // Goal system
        goal_set: goalSetTool({ pool: database.getPool() }),
        goal_update: goalUpdateTool({ pool: database.getPool() }),
        goal_list: goalListTool({ pool: database.getPool() }),
    },

    // ==================== Dispose ====================
    dispose: async () => {
      logging.info('Disposing...');

      // Final distillation of any remaining buffered tool calls
      if (config.distiller.enabled && currentSessionId) {
        const summary = toolDistiller.distill();
        if (summary.groups.length > 0) {
          try {
            const pool = database.getPool();
            const redactedCompressed = redactor.redact(summary.compressed).text;
            const redactedGroups = redactor.redact(JSON.stringify(summary.groups)).text;
            await pool.query(
              `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (session_id, md5(compressed)) DO NOTHING`,
              [
                summary.id,
                currentSessionId,
                redactedGroups,
                redactedCompressed,
                summary.totalCallsSummarized,
              ],
            );
            await refreshActiveContext(currentSessionId);
          } catch (error) {
            logging.error('Final distillation failed', error as Error);
          }
        }
      }

      if (currentSessionId && config.logSessionLifecycle) {
        await memoryManager.saveMemory({
          content: `Session ended after ${messageCount} messages. Final context snapshot.`,
          type: 'episodic',
          importance: 0.3,
          source: 'auto',
          tags: ['session-end', 'final-snapshot'],
          metadata: { sessionId: currentSessionId, messageCount },
          sessionId: currentSessionId,
        });
      }
      if (currentSessionId && config.workJournal?.persistOnDispose) {
        workJournal.recordSessionEnd(currentSessionId, ctx.directory, messageCount);
      }

      // Phase 21 — Self-continuity record at session end
      if (currentSessionId && config.selfContinuity.enabled) {
        try {
          const generator = new SelfContinuityGenerator(
            database.getPool(),
            currentSessionId,
            projectId,
          );
          await generator.writeRecord('session_end', {
            recalledSessionIds: [],
            recalledMemoryIds: [],
            evidenceAnchors: [],
            selfObservation: `Session ended after ${messageCount} messages.`,
            feltGap: undefined,
            goalContinued: false,
            alchemistInjected: false,
            checkpointResumed: false,
          });
        } catch (error) {
          logging.error('Self-continuity record failed', error as Error);
        }
      }

      contextRecall.stop();
      subconscious.stop();
      gitWatcher.stop();

      await memoryManager.cleanup();
      await database.disconnect();
      await flushDocUpdates(pluginCtx, ctx.directory);

      // Final stats write before shutting down
      await statsWriter.write().catch(() => {});
      statsWriter.stop();

      logging.info('Disposed');
    },
  };
}

export { CSM_TOOL_NAMES } from './tools.js';

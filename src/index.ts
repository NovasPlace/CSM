// Cross-Session Memory Plugin for Opencode
// Inspired by Agent Atlas - Persistent memory across conversations
// PostgreSQL with pgvector for semantic search
// FULLY AUTOMATED - No manual intervention required

import { PluginInput, PluginOptions, Hooks } from '@opencode-ai/plugin';
import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { MemoryManager } from './memory-manager.js';
import { MemoryExtractor } from './memory-extractor.js';
import { PrimingEngine } from './priming-engine.js';
import { ContextRecallDaemon } from './context-recall.js';
import { SubconsciousWatcher } from './subconscious.js';
import { GitWatcher } from './git-watcher.js';
import { LoopDetector } from './loop-detector.js';
import { flushDocUpdates } from './hooks/auto-docs.js';
import { Redactor } from './redactor.js';
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
import { runtimeStatusTool, CSM_TOOL_NAMES } from './tools.js';
import { PluginConfig, ToolCallRecord, CompactionResult } from './types.js';
import { CheckpointStore } from './checkpoint-store.js';
import { createCheckpointTool, expandCheckpointRefTool, listCheckpointsTool, type CheckpointToolDeps } from './checkpoint-tool.js';
import { buildCheckpointInjection, type CheckpointInjectDeps } from './checkpoint-inject.js';
import { createAutoCheckpoint, type AutoCheckpointTrigger } from './helpers/auto-checkpoint.js';
import { recordCompactionMetric, hasToolDiscardMarker } from './helpers/compaction-metrics.js';
import { createSessionCompactingHook, createAutocontinueHook } from './hooks/session-compaction.js';
import { createToolExecuteBeforeHook, createToolExecuteAfterHook } from './hooks/tool-execute.js';
import { createSystemTransformHook } from './hooks/system-transform.js';
import { SelfContinuityGenerator } from './self-continuity-generator.js';
import type { PluginContext } from './plugin-context.js';
import { DEFAULT_CONFIG } from './config.js';

// Default configuration is imported from config.ts

/**
 * Cross-Session Memory Plugin - AUTOMATED VERSION
 */
export default async (
  ctx: PluginInput,
  options?: PluginOptions
): Promise<Hooks> => {
  const config: PluginConfig = {
    ...DEFAULT_CONFIG,
    ...(options as Partial<PluginConfig> ?? {}),
  };

  console.log('[CrossSessionMemory] Initializing AUTOMATED memory system...');

  const database = new Database(config);
  const embeddings = new EmbeddingGenerator(config);
  const redactor = new Redactor(config.redactor);
  const memoryManager = new MemoryManager(database, embeddings, redactor);
  const memoryExtractor = new MemoryExtractor(database, memoryManager, config.extractor);
  const primingEngine = new PrimingEngine(database);
  const contextRecall = new ContextRecallDaemon(database, config.contextRecallInterval);
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

  // recordCompactionMetric and hasToolDiscardMarker extracted to helpers/compaction-metrics.ts

  try {
    await database.connect();
    console.log('[CrossSessionMemory] Database connected');
  } catch (error) {
    console.error('[CrossSessionMemory] Database connection failed:', error);
  }

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

  contextRecall.start();
  subconscious.start();
  gitWatcher.start();

  console.log('[CrossSessionMemory] AUTOMATED memory system initialized');

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
          toolDistiller.reset();
          
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
          console.log(`[CrossSessionMemory] message.updated fired - role: ${info?.role}, id: ${info?.id}`);
          
          if (info && info.role === 'assistant' && config.fullTranscripts) {
            const messageId = info.id;
            try {
              console.log(`[CrossSessionMemory] Fetching messages for session ${info.sessionID}`);
              const result = await ctx.client.session.messages({ path: { id: info.sessionID } });
              const messages = result.data;
              console.log(`[CrossSessionMemory] Got ${messages?.length ?? 0} messages from SDK`);
              
              if (messages) {
                const msg = messages.find((m: { info: { id: string } }) => m.info.id === messageId);
                console.log(`[CrossSessionMemory] Found target message: ${!!msg}, parts: ${msg?.parts?.length ?? 0}`);
                
                if (msg && msg.parts) {
                  let fullContent = '';
                  for (const part of msg.parts) {
                    if (part.type === 'text' && 'text' in part) {
                      fullContent += (part as { text: string }).text + '\n';
                    }
                  }
                  
                  console.log(`[CrossSessionMemory] Extracted content: ${fullContent.length} chars`);
                  
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

                    console.log(`[CrossSessionMemory] Capturing ASSISTANT message ${messageId} (${fullContent.length} chars, prev: ${existingLen})`);

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
                      },
                      sessionId: info.sessionID,
                    });
                  } else {
                    console.log(`[CrossSessionMemory] Skipping ${messageId} - not longer than existing (${fullContent.length} <= ${existingLen})`);
                  }
                }
              }
            } catch (e) {
              console.error('[CrossSessionMemory] Failed to fetch message parts:', e);
            }
          }
        }
      } catch (error) {
        console.error('[CrossSessionMemory] Event handling error:', error);
      }
    },

    // ==================== Config Hook - VERIFY PLUGIN LOADS ====================
    config: async (cfg) => {
      console.log('[CrossSessionMemory] Plugin loaded and config hook called');
    },

    // ==================== Chat Message Hook - CAPTURE USER MESSAGES ====================
    'chat.message': async (input, output) => {
      try {
        console.log(`[CrossSessionMemory] chat.message fired - sessionID: ${input.sessionID}, role: ${output.message?.role}, parts: ${output.parts?.length ?? 0}`);
        
        syncActiveSession(input.sessionID);

        if (!config.fullTranscripts || !input.sessionID) return;
        if (!output.parts || output.parts.length === 0) return;

        messageCount++;

        for (const part of output.parts) {
          if (part.type === 'text' && 'text' in part) {
            const content = (part as { text: string }).text;
            if (!content || content.length === 0) continue;
            recentUserMessages.set(input.sessionID, content);

            const msgId = output.message?.id ?? `user_${Date.now()}`;
            if (capturedMessageSizes.has(msgId)) continue;
            capturedMessageSizes.set(msgId, content.length);

            if (capturedMessageSizes.size > 500) {
              const entries = [...capturedMessageSizes.entries()];
              capturedMessageSizes.clear();
              entries.slice(-250).forEach(([id, len]) => capturedMessageSizes.set(id, len));
            }

            console.log(`[CrossSessionMemory] Capturing USER message ${msgId} (${content.length} chars)`);

            await memoryManager.saveMemory({
              content: `[user] ${content}`,
              type: 'conversation',
              importance: 0.3,
              source: 'auto',
              tags: ['auto-captured', 'conversation', 'full-transcript', 'user'],
              metadata: {
                messageId: msgId,
                role: 'user',
                fullTranscript: true,
                messageIndex: messageCount,
              },
              sessionId: input.sessionID,
            });
          }
        }
      } catch (error) {
        console.error('[CrossSessionMemory] Chat message capture error:', error);
      }
    },

    // ==================== Messages Transform - COMPACT + CAPTURE ====================
    'experimental.chat.messages.transform': async (input, output) => {
      try {
        if (!output.messages || output.messages.length === 0) return;

        if (config.promptDebug) {
          writePromptDebugLog(ctx.directory, 'before-normalization', output.messages as { info?: any; parts?: any[] }[], {
            currentSessionId,
          });
        }

        const normalization = normalizePromptMessages(output.messages as { info?: any; parts?: any[] }[], {
          cwd: ctx.directory,
          root: ctx.worktree ?? ctx.directory,
          sessionID: (output.messages[0] as any)?.info?.sessionID ?? currentSessionId ?? 'unknown',
        });
        if (normalization.convertedSystemMessages > 0 || normalization.droppedMessages > 0) {
          console.log(
            `[CrossSessionMemory] Prompt normalization: converted=${normalization.convertedSystemMessages} dropped=${normalization.droppedMessages}`,
          );
        }
        output.messages = normalization.messages as any;
        if (config.promptDebug) {
          writePromptDebugLog(ctx.directory, 'after-normalization', output.messages as { info?: any; parts?: any[] }[], {
            currentSessionId,
            convertedSystemMessages: normalization.convertedSystemMessages,
            droppedMessages: normalization.droppedMessages,
          });
        }
        if (output.messages.length === 0) return;

        // ── Token bucket: count ALL raw tokens BEFORE any compaction ──
        let rawToolTokens = 0;
        let rawAssistantTokens = 0;
        let rawUserTokens = 0;
        let finalToolTokens = 0;
        for (const msg of output.messages as { info?: { role?: string }; parts?: any[] }[]) {
          const role = msg.info?.role ?? 'unknown';
          for (const part of msg.parts ?? []) {
            const tokens = estimatePartTokens(part);
            if (role === 'user') {
              // User messages: count everything
              rawUserTokens += tokens;
            } else if (role === 'tool') {
              // Tool-role messages: tool outputs
              rawToolTokens += tokens;
            } else if (role === 'assistant') {
              // Assistant messages: separate tool parts from text
              if (part.type === 'tool') {
                rawToolTokens += tokens;
              } else {
                rawAssistantTokens += tokens;
              }
            }
          }
        }

        // ── Phase 6: Context rollover — cumulative token tracker + soft rollover ──
        if (config.contextRollover?.enabled) {
          try {
            const sid = (output.messages[0] as any)?.info?.sessionID;
            if (sid && sid !== 'unknown') {
              const pool = database.getPool();
              const rawTotalTokens = rawToolTokens + rawAssistantTokens + rawUserTokens;
              const rolloverResult: RolloverResult = await performRollover(
                pool,
                sid,
                output.messages as any[],
                rawTotalTokens,
                config.contextRollover,
                redactor,
              );
              if (rolloverResult.rolloverTriggered) {
                console.log(`[CrossSessionMemory] ${rolloverResult.auditLine}`);
              }
            }
          } catch (e) {
            console.error('[CrossSessionMemory] Context rollover error:', e);
          }
        }

        // ── Layer 2: Compact old tool parts BEFORE LLM conversion ──
        let toolCompactionSaved = 0;
        let toolCompactionResult: CompactionResult | null = null;
        let pressureResult: { action: 'ok' | 'recommend_flush' | 'urgent_flush'; estimatedTokens: number; pressure: number } | null = null;
        if (config.compactor.enabled) {
          const groups = toolDistiller.currentGroups;
          // Convert OpenCode messages (info.role + parts[]) to simple format for pressure estimation
          pressureResult = contextPressure.tick(
            (output.messages as { info?: { role?: string }; parts?: { text?: string }[] }[]).map((m) => ({
              role: m.info?.role ?? 'unknown',
              content: (m.parts ?? []).map((p) => p.text ?? '').join(' '),
            })),
          );
          const toolCalls = (output.messages as { info?: { role?: string }; parts?: any[] }[])
            .flatMap(m => {
              const role = m.info?.role ?? 'unknown';
              return (m.parts ?? []).filter(p => p.type === 'tool').map((p, idx) => ({
                tool: p.tool || 'unknown',
                args: (p.state?.input ?? {}) as Record<string, unknown>,
                output: p.state?.output ?? '',
                error: p.state?.type === 'error' ? (p.state?.message ?? '') : p.error,
                exitCode: p.state?.exitCode,
                timestamp: Date.now() - ((m.parts ?? []).length - idx - 1) * 60000, // rough timestamp
                sessionId: currentSessionId || 'unknown',
                filePath: (p.state?.input?.filePath || p.state?.input?.pattern) as string | undefined,
              }));
            });
          const messagesStr = (output.messages as { parts: { text?: string }[] }[])
            .flatMap(m => (m.parts ?? []).map(p => p.text ?? ''))
            .join('\n');
          const result = contextCompactor.compact(
            toolCalls as ToolCallRecord[],
            messagesStr,
            output.messages as any[]
          );
          toolCompactionResult = result.result;
          toolCompactionSaved = result.result.tokensSaved;
        }

        // ── Layer 3: Assistant text compaction (precision pass) ──
        let asstCompactionSaved = 0;
        if (config.assistantCompactor?.enabled) {
          const asstResult = compactAssistantText(
            output.messages as { info?: { role?: string }; parts?: any[] }[],
            config.assistantCompactor,
          );
          asstCompactionSaved = asstResult.tokensSaved;
          if (asstResult.tokensSaved > 0) {
            console.log(
              `[CrossSessionMemory] Assistant compaction: ${asstResult.partsCompacted}/${asstResult.messagesScanned} text parts — saved ~${asstResult.tokensSaved} tokens (${asstResult.savedPercent}%)`,
            );
          }
        }

        // ── Phase 6: Context cache — lazy context loading (before compiler) ──
        // NOTE: messages.transform input is typed {} (no sessionID, unlike
        // system.transform). The authoritative session id in this hook is the
        // sessionID attached to the prompt's messages — same value the manifest
        // read path (system.transform input.sessionID) and the tools
        // (context.sessionID) resolve to for the current session.
        if (config.contextCache?.enabled) {
          try {
            const sid = (output.messages[0] as any)?.info?.sessionID ?? 'unknown';
            const cacheResult = await cacheOldContext(
              database.getPool(),
              sid,
              output.messages as { info?: { role?: string }; parts?: any[] }[],
              {
                recentTurnWindow: config.contextCompiler?.recentTurnWindow ?? 3,
                minTokensToCache: config.contextCache.minTokensToCache ?? 200,
              },
            );
            if (cacheResult.itemsCached > 0) {
              console.log(
                `[CrossSessionMemory] Context cache: ${cacheResult.itemsCached} items cached, ~${cacheResult.tokensReplaced} tokens replaced with references`,
              );
            }
          } catch (e) {
            console.error('[CrossSessionMemory] Context cache error:', e);
          }
        }

        // ── Layer 5: Context compiler — input token governor ──
        let compileResult: CompileResult | null = null;
        if (config.contextCompiler?.enabled) {
          const governorResult = contextGovernor.govern(
            output.messages as { info?: { role?: string }; parts?: any[] }[],
          );
          compileResult = governorResult.compileResult
            ? governorResult.compileResult
            : compileContext(
              output.messages as { info?: { role?: string }; parts?: any[] }[],
              config.contextCompiler,
            );
          if (compileResult.partsCompressed > 0) {
            console.log(
              `[CrossSessionMemory] Context compiler: ${compileResult.partsCompressed} parts compressed, ${compileResult.beforeTokens} -> ${compileResult.afterTokens} tokens (budget: ${compileResult.budget}, mode: ${compileResult.mode})`,
            );
          }
          console.log(
            `[ContextGovernor] profile=${governorResult.decision.profile} action=${governorResult.decision.action} projected=${governorResult.decision.projectedNextTurnTokens} before=${governorResult.metricsBefore.totalTokens} after=${governorResult.metricsAfter.totalTokens}`,
          );
          // Store for status line injection (Layer 1)
          pluginCtx.lastCompileResult = compileResult;
          // Log to DB (Layer 3) — fire and forget, never block the transform
          if (config.contextCompiler?.logEnabled) {
            const sid = (output.messages[0] as any)?.info?.sessionID ?? 'unknown';
            logCompilation(database.getPool(), {
              sessionId: sid,
              mode: compileResult.mode,
              budget: compileResult.budget,
              beforeTokens: compileResult.beforeTokens,
              afterTokens: compileResult.afterTokens,
              partsCompressed: compileResult.partsCompressed,
              partsPinned: compileResult.partsPinned,
              compressedDetails: compileResult.compressedDetails,
              pinnedCategories: compileResult.pinnedCategories,
            }).catch((e: unknown) =>
              console.error('[CrossSessionMemory] Compilation log write failed:', e),
            );
          }
        }

        // ── Token bucket: count final tool output AFTER compaction ──
        for (const msg of output.messages as { parts?: any[] }[]) {
          for (const part of msg.parts ?? []) {
            if (part.type === 'tool' && (part.state?.status === 'completed' || part.state?.status === 'error')) {
              finalToolTokens += estimatePartTokens(part);
            }
          }
        }

        // ── Build and log full bucket breakdown ──
        if (toolCompactionSaved > 0 || asstCompactionSaved > 0) {
          const breakdown = analyzeMessages(
            output.messages as { parts?: any[]; info?: any }[],
            rawToolTokens,
            finalToolTokens,
          );
          breakdown.assistantTextRaw = rawAssistantTokens;
          breakdown.userMessagesRaw = rawUserTokens;
          breakdown.opencodeInternal = 32000; // estimated from prior session
          console.log(`[TokenBuckets] ${formatBreakdown(breakdown)}`);

          const activeSessionId = currentSessionId;
          const contextBrief = activeSessionId ? await contextRecall.getContextBrief() : null;
          const discardMarkerPresent = hasToolDiscardMarker(
            output.messages as { parts?: unknown[] }[],
          );
          if (activeSessionId && toolCompactionResult) {
            await recordCompactionMetric(database,
              activeSessionId,
              toolCompactionResult,
              contextBrief?.compressed.length ?? 0,
              discardMarkerPresent,
            );
          }
        }

        // Phase 4B — Auto-checkpoint triggers
        const autoConfig = config.checkpoint.auto;
        if (autoConfig?.enabled && currentSessionId) {
          // Context pressure trigger (only if compactor ran)
          if (config.compactor.enabled && pressureResult) {
            if (pressureResult.pressure > (autoConfig.contextPressureThreshold ?? 0.8)) {
              await autoCheckpoint(currentSessionId, 'context_pressure', {
                pressure: pressureResult.pressure,
                threshold: autoConfig.contextPressureThreshold ?? 0.8,
              });
            }
          }
          // Message count trigger
          const sessionMsgCount = (output.messages?.length ?? 0);
          if (sessionMsgCount > 0 && sessionMsgCount % (autoConfig.messageCountThreshold ?? 50) === 0) {
            await autoCheckpoint(currentSessionId, 'message_count', {
              messageCount: sessionMsgCount,
              threshold: autoConfig.messageCountThreshold ?? 50,
            });
          }
        }

        // 🧠 Capture assistant messages (existing logic) 🧠
        if (!config.fullTranscripts) return;

        const lastMsg = output.messages[output.messages.length - 1];
        if (!lastMsg?.info || lastMsg.info.role !== 'assistant') return;

        const info = lastMsg.info;
        const parts = lastMsg.parts;
        if (!info || !parts) return;

        const messageId = info.id;
        const existingLen = capturedMessageSizes.get(messageId) || 0;

        let fullContent = '';
        for (const part of parts) {
          if (part.type === 'text' && 'text' in part) {
            fullContent += (part as { text: string }).text + '\n';
          }
        }

        if (fullContent.trim().length === 0 || fullContent.length <= existingLen) return;

        capturedMessageSizes.set(messageId, fullContent.length);

        if (capturedMessageSizes.size > 500) {
          const entries = [...capturedMessageSizes.entries()];
          capturedMessageSizes.clear();
          entries.slice(-250).forEach(([id, len]) => capturedMessageSizes.set(id, len));
        }

        let importance = 0.3;
        const lower = fullContent.toLowerCase();
        if (lower.includes('decision') || lower.includes('solution')) importance = 0.6;
        if (lower.includes('error') || lower.includes('fix') || lower.includes('bug')) importance = 0.5;
        if (lower.includes('learn') || lower.includes('note')) importance = 0.5;

        messageCount++;

        console.log(`[CrossSessionMemory] Capturing ASSISTANT message ${messageId} (${fullContent.length} chars)`);

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
            partCount: parts.length,
          },
          sessionId: info.sessionID,
        });

        if (config.promptDebug) {
          writePromptDebugLog(ctx.directory, 'before-return', output.messages as { info?: any; parts?: any[] }[], {
            currentSessionId,
          });
        }
      } catch (error) {
        console.error('[CrossSessionMemory] Messages transform error:', error);
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
      console.log('[CrossSessionMemory] Disposing...');

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
               VALUES ($1, $2, $3, $4, $5)`,
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
            console.error('[CrossSessionMemory] Final distillation failed:', error);
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
          console.error('[CrossSessionMemory] Self-continuity record failed:', error);
        }
      }
      
      contextRecall.stop();
      subconscious.stop();
      gitWatcher.stop();
      
      await memoryManager.cleanup();
      await database.disconnect();
      await flushDocUpdates(pluginCtx);
      
      console.log('[CrossSessionMemory] Disposed');
    },
  };
};

export type { PluginConfig } from './types.js';

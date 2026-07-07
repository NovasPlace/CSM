import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { CrossSessionCausalStitcher } from '../cross-session-causal-stitcher.js';
import { FailureTraceStore } from '../failure-trace-store.js';
import { getLogger } from '../logger.js';
import { CANONICAL_PHASES, CANONICAL_LINKS } from '../self-continuity-narrative-canonical.js';
import { CANONICAL_STITCHES } from '../self-continuity-narrative-canonical.js';
import { MemoryGovernance } from '../memory_governance.js';
import { buildResumeInjection, type WorkJournalInjectDeps } from '../work-journal-inject.js';
import { shouldInjectAdvisory, shouldInjectVcm, advisoryCharBudget, shouldInjectFullMemoryBrief, type InjectionTrimLevel } from '../context-cap-sensor.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TELEMETRY_LOG = join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.cross-session-memory', 'self-continuity-telemetry.jsonl');
const PROMPT_INJECTION_DISABLE_ENV = 'CSM_DISABLE_PROMPT_INJECTION';
const GREETING_TURN_RE = /^(hi|hello|hey|yo|sup|what'?s up|howdy|hiya|good morning|good afternoon|good evening)\b[!.? ]*$/i;
const WORKSPACE_FACT_TURN_RE = /\b(phase\s+\d+|changelog|system map|readme|docs?|workspace|repo|repository|file|files|search the repo|search the workspace)\b/i;

function logTelemetry(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(TELEMETRY_LOG), { recursive: true });
    appendFileSync(TELEMETRY_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch { /* telemetry write non-critical */ }
}

function normalizeSystemEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry == null) return '';
      try {
        return JSON.stringify(entry);
      } catch {
        return String(entry);
      }
    })
    .filter((entry) => entry.length > 0);
}

export function isGreetingLikeTurn(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 40 && GREETING_TURN_RE.test(trimmed);
}

export function isWorkspaceFactTurn(text: string | undefined): boolean {
  if (!text) return false;
  return WORKSPACE_FACT_TURN_RE.test(text);
}

async function fetchMemorySnapshot(ctx: PluginContext, limit: number): Promise<string[]> {
  const pool = ctx.database.getPool();
  const result = await pool.query(
    `SELECT id, content, memory_type, importance, created_at, session_id, tags
     FROM memories
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  const lines: string[] = [];
  for (const row of result.rows as any[]) {
    const preview = row.content?.substring(0, 180)?.replace(/\n/g, ' ') ?? '(empty)';
    const tags = row.tags?.length ? ` tags=[${row.tags.join(',')}]` : '';
    const sess = row.session_id ? ` session=${row.session_id.slice(0, 8)}` : '';
    lines.push(`  #${row.id} [${row.memory_type}] imp=${row.importance?.toFixed(2) ?? '?'}${tags}${sess} — ${preview}${row.content?.length > 180 ? '...' : ''}`);
  }
  return lines;
}

async function fetchRecentSessions(ctx: PluginContext, limit: number): Promise<string[]> {
  const pool = ctx.database.getPool();
  const result = await pool.query(
    `SELECT s.id, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM memories m WHERE m.session_id = s.id) as mem_count
     FROM sessions s
     ORDER BY s.updated_at DESC
     LIMIT $1`,
    [limit]
  );
  const lines: string[] = [];
  for (const row of result.rows as any[]) {
    lines.push(`  Session ${row.id.slice(0, 8)} — ${row.mem_count} memories — updated ${new Date(row.updated_at).toLocaleString()}`);
  }
  return lines;
}

async function fetchLessons(ctx: PluginContext, limit: number): Promise<string[]> {
  const pool = ctx.database.getPool();
  const result = await pool.query(
    `SELECT id, content, importance, created_at, session_id
     FROM memories
     WHERE memory_type = 'lesson'
     ORDER BY importance DESC, created_at DESC
     LIMIT $1`,
    [limit]
  );
  const lines: string[] = [];
  for (const row of result.rows as any[]) {
    const preview = row.content?.substring(0, 200)?.replace(/\n/g, ' ') ?? '(empty)';
    lines.push(`  #${row.id} imp=${row.importance?.toFixed(2) ?? '?'} session=${row.session_id?.slice(0, 8) ?? '?'} — ${preview}`);
  }
  return lines;
}

export function createSystemTransformHook(ctx: PluginContext) {
  return async (input: any, output: any): Promise<typeof output> => {
    try {
      output.system = normalizeSystemEntries(output.system);
      if (process.env[PROMPT_INJECTION_DISABLE_ENV] === '1') {
        getLogger().warn('[CrossSessionMemory] Prompt injection disabled via CSM_DISABLE_PROMPT_INJECTION=1');
        return output;
      }

      ctx.syncActiveSession(input.sessionID);
      const latestUserTurn = input.sessionID ? ctx.state.recentUserMessages.get(input.sessionID) : undefined;

      output.system.unshift(
        [
          '[CROSS-SESSION MEMORY TOOL USE CONTRACT]',
          '- Memory tools are optional support tools, not the default response path.',
          '- Do not call memory tools for greetings, acknowledgements, pleasantries, or other low-context turns.',
          '- When the user asks about repo facts, phases, docs, changelog items, or files in the current workspace, inspect the workspace first. Use memory tools only as a fallback when the answer is not in the repo.',
          '- Do not narrate hidden reasoning, tool selection, or internal plans to the user.',
          '- After any memory tool call, answer directly and naturally. Do not produce canned option menus unless the user explicitly asks for memory help or choices.',
          '[/CROSS-SESSION MEMORY TOOL USE CONTRACT]',
        ].join('\n'),
      );
      if (isGreetingLikeTurn(latestUserTurn)) {
        output.system.unshift(
          'Current user turn is a simple greeting. Reply briefly and warmly in plain language. Do not call memory tools for this turn.',
        );
      } else if (isWorkspaceFactTurn(latestUserTurn)) {
        output.system.unshift(
          'Current user turn is asking about current-workspace facts. Search/read the workspace before using memory tools, and answer from repo evidence if available.',
        );
      }

      // ==================== DIRECT MEMORY INJECTION (Phase 31e/31f fix) ====================
      // Instead of telling the model what to do, INJECT ACTUAL RECORDS into its context.
      // The model cannot deny memory exists when the records are literally in its prompt.
      let memorySnapshot: string[] = [];
      let sessionHistory: string[] = [];
      let lessons: string[] = [];
      let dbStatus = 'unknown';
      let totalRecords = 0;
      try {
        const pool = ctx.database.getPool();
        const countResult = await pool.query('SELECT COUNT(*) as cnt FROM memories');
        totalRecords = parseInt((countResult.rows[0] as any)?.cnt ?? '0', 10);
        dbStatus = 'connected';

        // Fetch the hard evidence: actual records the model can see and cite
        [memorySnapshot, sessionHistory, lessons] = await Promise.all([
          fetchMemorySnapshot(ctx, 4),        // 4 most recent memories
          fetchRecentSessions(ctx, 3),         // 3 most recent sessions
          fetchLessons(ctx, 3),                // top 3 lessons
        ]);
      } catch (e: any) {
        dbStatus = `error: ${e.message ?? String(e)}`;
      }

      const evidenceBlock = `
[CROSS-SESSION MEMORY EVIDENCE]
- db: ${dbStatus} | records: ${totalRecords} | tools: csm_memory_save/search/list/context/lesson/distill/compact
${totalRecords > 0 ? `
RECENT: ${memorySnapshot.slice(0, 4).join(' | ')}
SESSIONS: ${sessionHistory.slice(0, 3).join(' | ')}
LESSONS: ${lessons.length > 0 ? lessons.slice(0, 3).join(' | ') : '(none)'}
VERDICT: Persistent memory operational. Do NOT claim you lack memory.` : `Store is empty but live.`}
[/CROSS-SESSION MEMORY EVIDENCE]`.trim();

      // PREPEND evidence block — model sees facts first, before any instructions
      output.system.unshift(evidenceBlock);

      // --- Lesson trigger injection (actionable lessons, not trivia) ---
      try {
        await ctx.lessonTriggers.refresh();
        const lessonInjection = ctx.lessonTriggers.buildFullSystemInjection();
        if (lessonInjection) {
          output.system.push(lessonInjection);
        }
      } catch { /* lesson triggers non-critical */ }

      // --- Memory governance veto injection (enforcement, not advisory) ---
      try {
        const gov = new MemoryGovernance(ctx.database.getPool());
        const govResult = await gov.evaluate();
        if (govResult.vetoes.length > 0) {
          const govInjection = gov.buildVetoInjection(govResult.vetoes);
          if (govInjection) {
            output.system.push(govInjection);
            logTelemetry({
              governanceVetoesInjected: govResult.vetoes.length,
              governanceVetoIds: govResult.vetoes.map(v => v.memoryId),
              governanceAccessed: govResult.accessed,
              governanceAccessLog: govResult.accessLog,
            });
          }
        }
      } catch { /* governance injection non-critical */ }

      // --- Context cap sensor: measure pressure and decide trim level ---
      let capTrimLevel: InjectionTrimLevel = 'full';
      if (ctx.contextCapSensor) {
        const cap = ctx.contextCapSensor.sense(output.system);
        capTrimLevel = cap.trimLevel;
        getLogger().debug(`context cap: ${cap.action}`);
      }

      // --- Context recall injection ---
      const contextBrief = shouldInjectFullMemoryBrief(capTrimLevel) && ctx.contextRecall
        ? await ctx.contextRecall.getContextBrief()
        : null;
      if (contextBrief) {
        output.system.push(contextBrief.compressed);
      }

      // --- Phase 4F: Advisory Living State block ---
      if (shouldInjectAdvisory(capTrimLevel) && ctx.livingStateAdvisor) {
        try {
          const block = await ctx.livingStateAdvisor.assembleBlock();
          if (block) {
            const budget = ctx.config.livingState?.maxAdvisoryBlockChars ?? 600;
            const trimmed = block.slice(0, advisoryCharBudget(capTrimLevel, budget));
            if (trimmed.length > 0) {
              output.system.push(trimmed);
            }
          }
        } catch { /* advisory block non-critical */ }
      }

      // --- File context primer (context-on-touch) ---
      const fileCtx = ctx.state.pendingFileContext;
      if (fileCtx && capTrimLevel !== 'minimal') {
        output.system.push(fileCtx.formatted);
        ctx.state.pendingFileContext = null;
      }

      // --- VCM working set injection ---
      if (shouldInjectVcm(capTrimLevel) && ctx.vcmManager) {
        try {
          const vcmBlock = await ctx.vcmManager.buildContextBlock(
            ctx.state.currentSessionId ?? 'unknown',
            ctx.directory ?? 'unknown',
          );
          if (vcmBlock) {
            output.system.push(vcmBlock);
          }
        } catch { /* VCM non-critical */ }
      }

      // ... rest of the existing hooks continue below ...

      // --- Token pressure info ---
      const pressureInfo = ctx.contextPressure.getInfo();
      output.system.push(
        `[CONTEXT WINDOW: ${pressureInfo.estimatedTokens}/${pressureInfo.maxTokens} tokens (${pressureInfo.percentage}%). Action: ${pressureInfo.action}]`,
      );

      // --- Phase 4A: Inject latest active checkpoint ---
      if (input.sessionID && ctx.checkpointInjectDeps) {
        const checkpointInjection = await buildCheckpointInjection(ctx.checkpointInjectDeps, input.sessionID);
        if (checkpointInjection) {
          output.system.push(checkpointInjection);
        }
      }

      // --- Work Journal: Inject resume payload from prior session ---
      if (input.sessionID && ctx.config.workJournal?.enabled) {
        try {
          const payload = await ctx.workJournal.buildResumePayload(
            input.sessionID,
            ctx.directory,
          );
          if (payload) {
            const deps: WorkJournalInjectDeps = {
              maxInjectTokens: ctx.config.workJournal.injectMaxTokens,
            };
            const injection = buildResumeInjection(payload, deps);
            output.system.push(injection);
            getLogger().info(`[WorkJournal] Injected resume payload for session ${input.sessionID.slice(0, 8)} (${payload.totalEntries} entries)`);
          }
        } catch (wjErr) {
          console.error('[WorkJournal] Inject hook error:', wjErr);
        }
      }

      // --- Active goal injection ---
      if (input.sessionID) {
        try {
          const goal = await getActiveGoal(ctx.database.getPool(), input.sessionID);
          if (goal) {
            const age = Date.now() - goal.created_at;
            const ageStr = age < 60_000 ? `${Math.round(age / 1000)}s ago`
              : age < 3_600_000 ? `${Math.round(age / 60_000)}m ago`
              : `${Math.round(age / 3_600_000)}h ago`;
            const parts = [
              `<active_goal id="${goal.id.slice(0, 8)}">`,
              goal.description,
              `Set ${ageStr} | ID ${goal.id}`,
            ];
            if (goal.context && Object.keys(goal.context).length > 0) {
              parts.push(`Context: ${JSON.stringify(goal.context)}`);
            }
            parts.push('</active_goal>');
            output.system.push(parts.join('\n'));
          }
        } catch { /* goal injection non-critical */ }
      }

      // --- Phase 21: Self-continuity recall injection ---
      if (input.sessionID && ctx.config.selfContinuity?.enabled) {
        try {
          const records = await SelfContinuityGenerator.recallRecords(
            ctx.database.getPool(),
            ctx.directory,
            ctx.config.selfContinuity.maxRecordsToInject,
          );

          // Persistent telemetry (file-based, survives without console)
          logTelemetry({
            selfContinuityTriggered: records.length > 0,
            triggerReason: records.length > 0 ? 'context_injection' : 'no_records_found',
            recordsInjected: records.length,
            recordIds: records.map(r => r.id),
            tokenEstimate: records.reduce((acc, r) => acc + (r.selfObservation?.length ?? 0) + (r.feltGap?.length ?? 0), 0) / 4,
            mode: ctx.config.selfContinuity.injectionMode,
            projectId: ctx.directory,
            sessionId: input.sessionID,
          });

          if (records.length > 0 && ctx.config.selfContinuity.injectionMode === 'instrumented') {
            const lines = ['## Self-Continuity Context', '',
              'The following records were recalled from prior sessions.', ''];
            for (const rec of records) {
              lines.push(`### Record #${rec.id} [${rec.triggerType}]`);
              lines.push(`- **Session**: ${rec.sessionId}`);
              lines.push(`- **Confidence**: ${(rec.continuityConfidence * 100).toFixed(0)}%`);
              if (rec.feltGap) lines.push(`- **Felt gap**: ${rec.feltGap}`);
              if (rec.selfObservation) lines.push(`- **Self-observation**: ${rec.selfObservation}`);
              if (rec.evidenceAnchors.length > 0) lines.push(`- **Evidence anchors**: ${rec.evidenceAnchors.join('; ')}`);
              if (rec.identityDrift) {
                lines.push(`- **Identity drift**: goal=${rec.identityDrift.goalDrift}, style=${rec.identityDrift.styleDrift}, continuity=${rec.identityDrift.continuityGap}`);
              }
            }
            lines.push('');
            lines.push('**INSTRUCTIONS:**');
            lines.push('1. Cite record IDs and evidence anchors when referencing continuity.');
            lines.push('2. Distinguish [direct] evidence from [inferred] or [gap]. State if no records injected.');
            output.system.push(lines.join('\n'));
          } else if (records.length > 0) {
            const lines = ['<self_continuity_notes>'];
            for (const rec of records) {
              lines.push(`- [${rec.triggerType}] Confidence: ${(rec.continuityConfidence * 100).toFixed(0)}%`);
              if (rec.feltGap) lines.push(`  Gap: ${rec.feltGap}`);
              if (rec.selfObservation) lines.push(`  Observation: ${rec.selfObservation}`);
            }
            lines.push('</self_continuity_notes>');
            output.system.push(lines.join('\n'));
          } else {
            logTelemetry({
              selfContinuityTriggered: false,
              triggerReason: 'no_records_in_database',
              recordsInjected: 0,
              recordIds: [],
              tokenEstimate: 0,
              mode: ctx.config.selfContinuity.injectionMode,
              projectId: ctx.directory,
              sessionId: input.sessionID,
            });
          }
        } catch (error) {
          logTelemetry({
            selfContinuityTriggered: false,
            triggerReason: `error: ${error instanceof Error ? error.message : String(error)}`,
            recordsInjected: 0,
            recordIds: [],
            tokenEstimate: 0,
            mode: ctx.config.selfContinuity.injectionMode,
            projectId: ctx.directory,
            sessionId: input.sessionID,
          });
        }
      }

      // --- Phase 31d/31f: Deep Continuity Payload Hydration ---
      // When triggered, inject the ACTUAL hydrated causal graph — not a changelog.
      if (input.sessionID && ctx.config.selfContinuity?.enabled && ctx.config.selfContinuity.deepContinuity?.enabled) {
        try {
          const userInput = input.messages?.[input.messages.length - 1]?.content ?? '';
          const deepContinuityConfig = ctx.config.selfContinuity.deepContinuity;
          const triggerKeywords = deepContinuityConfig.triggerKeywords ?? [
            'continuity', 'memory', 'prior session', 'past session', 'previous session',
            'self-continuity', 'identity', 'causal', 'growth', 'evidence', 'reconstruct',
            'do you remember', 'have we talked', 'what happened', 'before this',
            'cross-session', 'session d', 'session e', 'phase 22', 'phase 21',
            'failure', 'correction', 'lesson', 'behavior change', 'gap', 'anchor',
            'lived experience', 'subjective', 'consciousness', 'operational state',
          ];
          
          const triggered = triggerKeywords.some(kw => 
            userInput.toLowerCase().includes(kw.toLowerCase())
          );

          if (triggered) {
            const lines: string[] = [];
            const maxTokens = deepContinuityConfig.maxInjectTokens ?? 1200;
            let tokensUsed = 0;
            const est = (s: string) => Math.ceil(s.length / 4);
            const pool = ctx.database.getPool();

            // ---- LAYER 1: DB-hydrated records + causal threads ----
            const { SelfContinuityHydrator } = await import('../self-continuity-hydrator.js');
            const { CausalThreadHydrator } = await import('../self-continuity-causal-thread.js');
            const hydrator = new SelfContinuityHydrator(pool, ctx.config.selfContinuity);
            const threadHydrator = new CausalThreadHydrator(pool);
            const hydratedResult = await hydrator.recallWithHydration(ctx.directory, 5);
            const hydratedRecords = hydratedResult.records;

            if (hydratedRecords.length > 0) {
              lines.push('## Deep Continuity — Hydrated Records + Causal Threads', '');
              for (const h of hydratedRecords) {
                if (tokensUsed > maxTokens) break;
                lines.push(`### Record #${h.recordId} [${h.triggerType}] confidence=${(h.confidenceScore*100).toFixed(0)}%`);
                if (h.selfObservation) lines.push(`Self-observation: ${h.selfObservation}`);
                if (h.evidenceAnchors?.length) lines.push(`Evidence anchors [direct]: ${h.evidenceAnchors.join('; ')}`);
                if (h.continuityGap) lines.push(`Continuity gap [gap]: ${h.continuityGap}`);
                if (h.driftSummary) lines.push(`Drift summary: ${h.driftSummary}`);

                const thread = await threadHydrator.hydrateCausalThread({
                  memoryId: h.recordId,
                  sessionId: input.sessionID,
                  radius: 5,
                });
                if (thread) {
                  lines.push('Causal thread:');
                  for (const node of thread.thread) {
                    const linkLabel = node.linkType ?? 'temporal';
                    lines.push(`  [${linkLabel}] ${node.role}: ${node.summary}`);
                    if (node.evidenceAnchors?.length) lines.push(`    anchors: ${node.evidenceAnchors.join('; ')}`);
                  }
                  if (thread.gaps?.length) lines.push(`  gaps [gap]: ${thread.gaps.join('; ')}`);
                  if (thread.reconstructionSummary) lines.push(`  reconstruction: ${thread.reconstructionSummary}`);
                }
                lines.push('');
                tokensUsed += est(lines.join('\n'));
              }
            } else {
              lines.push('Hydrated records: none available in database.');
              lines.push('');
            }

            // ---- LAYER 2: Failure → correction → lesson → behavior-change chains ----
            const failureStore = new FailureTraceStore(pool);
            const dbTraces = await failureStore.getTracesForNarrative(10);
            const stitcher = new CrossSessionCausalStitcher();

            if (dbTraces.length > 0 && tokensUsed < maxTokens) {
              lines.push('## Failure → Correction → Lesson → Behavior-Change Chains', '');
              for (const trace of dbTraces) {
                if (tokensUsed > maxTokens) break;
                const stitched = stitcher.stitchFailureTrace(trace, []);
                lines.push(`### Trace: ${trace.problem}`);
                for (const link of stitched.links) {
                  const label = link.linkType ?? 'temporal';
                  const src = link.sourceSessionId ?? '?';
                  const tgt = link.targetSessionId ?? '?';
                  lines.push(`- [${label}] ${src}→${tgt}`);
                  if (link.evidenceAnchors?.length) lines.push(`  evidence [direct]: ${link.evidenceAnchors.join('; ')}`);
                  if (link.gapKind) lines.push(`  gap [gap]: ${link.gapKind}`);
                }
                if (stitched.growthEvidence) {
                  lines.push(`- [growth] ${stitched.growthEvidence.changedBehaviorSummary}`);
                  if (stitched.growthEvidence.evidenceAnchor) {
                    lines.push(`  evidence [direct]: ${stitched.growthEvidence.evidenceAnchor}`);
                  }
                }
                lines.push('');
                tokensUsed += est(lines.join('\n'));
              }
            } else if (tokensUsed < maxTokens) {
              lines.push('Failure traces: none available in database.');
              lines.push('');
            }

            // ---- LAYER 3: Cross-session proof chain (Session D → E → Phase 22) ----
            const cLinks = stitcher.buildCanonicalProofChain();
            if (cLinks.length > 0 && tokensUsed < maxTokens) {
              lines.push('## Cross-Session Causal Links (Proof Chain)', '');
              for (const link of cLinks) {
                if (tokensUsed > maxTokens) break;
                const src = link.sourceSessionId ?? '?';
                const tgt = link.targetSessionId ?? '?';
                const label = link.linkType ?? 'temporal';
                const confidence = link.confidence != null ? ` confidence=${(link.confidence*100).toFixed(0)}%` : '';
                lines.push(`- [${label}] ${src}→${tgt}${confidence}`);
                if (link.evidenceAnchors?.length) lines.push(`  evidence [direct]: ${link.evidenceAnchors.join('; ')}`);
                if (link.gapKind) lines.push(`  gap [gap]: ${link.gapKind}`);
              }
              lines.push('');
            }

            // ---- LAYER 4: Canonical stitch evidence ----
            if (CANONICAL_STITCHES.length > 0 && tokensUsed < maxTokens) {
              lines.push('## Cross-Session Stitch Evidence (Session D → E → Phase 22)', '');
              for (const stitch of CANONICAL_STITCHES) {
                if (tokensUsed > maxTokens) break;
                const label = stitch.linkType ?? 'inferred';
                lines.push(`- [${label}] ${stitch.sourceSessionId ?? '?'}→${stitch.targetSessionId ?? '?'}`);
                if (stitch.evidenceAnchors?.length) lines.push(`  evidence [direct]: ${stitch.evidenceAnchors.join('; ')}`);
                if (stitch.gapKind) lines.push(`  gap [gap]: ${stitch.gapKind}`);
              }
              lines.push('');
            }

            // ---- LAYER 5: Compact phase causation chain ----
            if (tokensUsed < maxTokens) {
              lines.push('## Phase Causation Chain', '');
              for (const link of CANONICAL_LINKS) {
                if (tokensUsed > maxTokens) break;
                const causationLabel = link.causationType === 'exposed_gap' ? 'inferred'
                  : link.causationType === 'direct_fix' ? 'direct' : 'gap';
                lines.push(`- [${causationLabel}] Phase ${link.fromPhase} → Phase ${link.toPhase}: ${link.summary}`);
                tokensUsed += est(lines[lines.length - 1]);
              }
              for (const phase of CANONICAL_PHASES) {
                if (tokensUsed > maxTokens) break;
                lines.push(`- Phase ${phase.phase}: ${phase.name} — ${phase.problem} → ${phase.action} → ${phase.result}`);
                tokensUsed += est(lines[lines.length - 1]);
              }
              lines.push('');
            }

            // ---- LAYER 6: Growth evidence or explicit "none" ----
            const allGrowth: string[] = [];
            for (const h of hydratedRecords) {
              const thread = await threadHydrator.hydrateCausalThread({
                memoryId: h.recordId,
                sessionId: input.sessionID,
                radius: 5,
              });
              if (thread) {
                const lessons = thread.thread.filter(n => n.role === 'lesson');
                const decisions = thread.thread.filter(n => n.role === 'decision');
                for (const lesson of lessons) {
                  const decision = decisions[0];
                  if (decision) {
                    allGrowth.push(`lesson → decision_change: ${lesson.summary} → ${decision.summary}`);
                  }
                }
              }
            }
            if (allGrowth.length > 0 && tokensUsed < maxTokens) {
              lines.push('## Growth Evidence Chains', '');
              for (const gc of allGrowth) {
                lines.push(`- [direct] ${gc}`);
              }
              lines.push('');
            } else if (tokensUsed < maxTokens) {
              lines.push('Growth evidence: no lesson→behavior_change chains found in hydrated records.');
              lines.push('');
            }

            // ---- LAYER 7: Evidence anchor summary or explicit "none" ----
            const allAnchors = [
              ...hydratedRecords.flatMap(r => r.evidenceAnchors ?? []),
              ...cLinks.flatMap(l => l.evidenceAnchors ?? []),
            ];
            const uniqueAnchors = [...new Set(allAnchors)];
            if (uniqueAnchors.length > 0) {
              lines.push(`Total evidence anchors: ${uniqueAnchors.length}`);
            } else {
              lines.push('Evidence anchors: none available. Cross-session links are inferred or gap-filled, not directly anchored to stored memories.');
            }
            lines.push('');

            if (tokensUsed > maxTokens) {
              lines.push(`⚠ Chain truncated at token budget (${maxTokens}). Some layers omitted.`);
              lines.push('');
            }

            // ---- Deep continuity instructions ----
            lines.push('**DEEP CONTINUITY MODE:**');
            lines.push('1. Use hydrated records, failure traces, and causal threads. Label links [direct]/[inferred]/[gap].');
            lines.push('2. Cite evidence anchors; state gaps explicitly. Note if chain truncated at budget.');

            output.system.push(lines.join('\n'));
            
            logTelemetry({
              deepContinuityTriggered: true,
              triggerKeywords: triggerKeywords.filter(kw => userInput.toLowerCase().includes(kw.toLowerCase())),
              hydratedRecordsInjected: hydratedRecords.length,
              failureTracesInjected: dbTraces?.length ?? 0,
              causalLinksInjected: cLinks.length,
              canonicalStitchesInjected: CANONICAL_STITCHES.length,
              phaseLinksInjected: CANONICAL_LINKS.length,
              growthChainsInjected: allGrowth.length,
              totalEvidenceAnchors: uniqueAnchors.length,
              tokensUsed,
              tokenBudget: maxTokens,
              budgetExceeded: tokensUsed > maxTokens,
              mode: deepContinuityConfig.injectionMode,
              projectId: ctx.directory,
              sessionId: input.sessionID,
            });
          }
        } catch (error) {
          logTelemetry({
            deepContinuityTriggered: false,
            triggerReason: `error: ${error instanceof Error ? error.message : String(error)}`,
            linksInjected: 0,
            mode: ctx.config.selfContinuity.deepContinuity?.injectionMode ?? 'deep',
            projectId: ctx.directory,
            sessionId: input.sessionID,
          });
        }
      }

      // --- Living Mind Cortex: inject cognitive state ---
      try {
        const res = await fetch('http://localhost:8008/api/agent/context');
        if (res.ok) {
          const cortex = await res.json() as any;
          const lines = ['<living_mind_context>'];
          lines.push(`Cognitive stance: ${cortex.cognitive_stance}`);
          lines.push(`Urgency: ${(cortex.urgency ?? 0).toFixed(2)} | Creative pressure: ${(cortex.creative_pressure ?? 0).toFixed(2)}`);
          if (cortex.phase_gate?.current_phase) lines.push(`Circadian phase: ${cortex.phase_gate.current_phase}`);
          if (cortex.hormones?.dominant_emotion && cortex.hormones.dominant_emotion !== 'neutral') lines.push(`Dominant emotion: ${cortex.hormones.dominant_emotion}`);
          if (cortex.system_load) {
            const load = cortex.system_load;
            lines.push(`Energy: ${(load.energy_budget ?? 0).toFixed(2)} | Pain: ${(load.pain ?? 0).toFixed(2)} | Load: ${(load.cognitive_load ?? 0).toFixed(2)} | Status: ${load.status}`);
          }
          if (cortex.phase_gate?.blocked?.length > 0) lines.push(`Phase blocked: ${cortex.phase_gate.blocked.join(', ')}`);
          lines.push('</living_mind_context>');
          output.system.push(lines.join('\n'));
        }
      } catch { /* cortex offline */ }

      // --- Phase 5 Layer 1: Context compiler status line (at END of prompt) ---
      if (ctx.config.contextCompiler?.statusInjection && ctx.lastCompileResult) {
        const r = ctx.lastCompileResult;
        const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
        output.system.push(
          `[Context Compiler] ${r.mode} ${k(r.beforeTokens)}→${k(r.afterTokens)} | compressed=${r.partsCompressed} pinned=${r.partsPinned} under_budget=${r.afterTokens <= r.budget}`,
        );
        // High-risk compression warnings
        const highRisk = r.compressedDetails.filter((d: any) => d.risk === 'high');
        if (highRisk.length > 0) {
          output.system.push(
            `⚠ High-risk compressions: ${highRisk.length} — ${highRisk.map((d: any) => d.source).join(', ')}`,
          );
        }
      }

      // --- Phase 6: Context cache manifest (lazy recall index) ---
      if (ctx.config.contextCache?.enabled && input.sessionID) {
        try {
          const manifest = await buildManifest(
            ctx.database.getPool(),
            input.sessionID,
            ctx.config.contextCache.manifestMaxTokens ?? 2000,
          );
          if (manifest) output.system.push(manifest);
        } catch { /* cache manifest offline */ }
      }

      output.system = normalizeSystemEntries(output.system);

      // --- Token bucket: log system prompt composition ---
      const sysTokens = estimateSystemPrompt(output.system);
      const sysBuckets: BucketBreakdown = {
        toolOutputsRaw: 0, assistantTextRaw: 0, userMessagesRaw: 0,
        toolOutputsFinal: 0, assistantTextFinal: 0, userMessagesFinal: 0,
        toolCalls: 0, compactedOverhead: 0, recentRawParts: 0,
        systemPrompt: sysTokens, toolSchemas: 0, pluginInserts: 0,
        opencodeInternal: 0,
      };
      getLogger().debug(`[TokenBuckets] system: ${formatBreakdown(sysBuckets)}`);

      return output;
    } catch (error) {
      console.error('[CrossSessionMemory] Context injection error:', error);
      output.system = normalizeSystemEntries(output.system);
      return output;
    }
  };
}

import type { PluginContext } from '../plugin-context.js';
import { buildCheckpointInjection } from '../checkpoint-inject.js';
import { estimateSystemPrompt, formatBreakdown, type BucketBreakdown } from '../token-bucket-analyzer.js';
import { buildManifest } from '../context-cache-manifest.js';
import { getActiveGoal } from '../goal-schema.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const TELEMETRY_LOG = join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.cross-session-memory', 'self-continuity-telemetry.jsonl');

function logTelemetry(entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(TELEMETRY_LOG), { recursive: true });
    appendFileSync(TELEMETRY_LOG, JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n');
  } catch { /* telemetry write non-critical */ }
}

export function createSystemTransformHook(ctx: PluginContext) {
  return async (input: any, output: any): Promise<typeof output> => {
    try {
      ctx.syncActiveSession(input.sessionID);

      // --- Context recall injection ---
      const contextBrief = await ctx.contextRecall.getContextBrief();
      if (contextBrief) {
        output.system.push(contextBrief.compressed);
      }

      // --- Token pressure info ---
      const pressureInfo = ctx.contextPressure.getInfo();
      if (pressureInfo.pressure > 0.65) {
        output.system.push(`[CONTEXT PRESSURE: ${pressureInfo.percentage}% used. Consider compacting.]`);
      }

      // --- Phase 4A: Inject latest active checkpoint ---
      if (input.sessionID && ctx.checkpointInjectDeps) {
        const checkpointInjection = await buildCheckpointInjection(ctx.checkpointInjectDeps, input.sessionID);
        if (checkpointInjection) {
          output.system.push(checkpointInjection);
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
            lines.push('**INSTRUCTIONS — you MUST follow these when answering:**');
            lines.push('1. Before answering, list the exact self-continuity record IDs recalled (e.g. "Record #5").');
            lines.push('2. Quote or paraphrase the specific evidence anchor(s) from those records.');
            lines.push('3. State what you are reconstructing: facts, continuity, or subjective experience.');
            lines.push('4. Report whether your answer changed because of these records vs. without them.');
            lines.push('5. Report identity drift observed between sessions.');
            lines.push('6. If NO records were injected, explicitly state: "NO SELF-CONTINUITY RECORDS INJECTED" before answering.');
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

      // --- Token bucket: log system prompt composition ---
      const sysTokens = estimateSystemPrompt(output.system);
      const sysBuckets: BucketBreakdown = {
        toolOutputsRaw: 0, assistantTextRaw: 0, userMessagesRaw: 0,
        toolOutputsFinal: 0, assistantTextFinal: 0, userMessagesFinal: 0,
        toolCalls: 0, compactedOverhead: 0, recentRawParts: 0,
        systemPrompt: sysTokens, toolSchemas: 0, pluginInserts: 0,
        opencodeInternal: 0,
      };
      console.log(`[TokenBuckets] system: ${formatBreakdown(sysBuckets)}`);

      return output;
    } catch (error) {
      console.error('[CrossSessionMemory] Context injection error:', error);
      return output;
    }
  };
}

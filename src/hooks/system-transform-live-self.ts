import type { PluginContext } from '../plugin-context.js';
import { SelfContinuityGenerator } from '../self-continuity-generator.js';
import type { SelfContinuityRecord } from '../self-continuity-types.js';
import { logSystemTransformTelemetry } from './system-transform-live-telemetry.js';
import type {
  SystemTransformInput,
  SystemTransformOutput,
} from './system-transform-live-types.js';

function buildInstrumentedBlock(records: SelfContinuityRecord[]): string {
  const lines = [
    '## Self-Continuity Context',
    '',
    'The following records were recalled from prior sessions.',
    '',
  ];
  for (const record of records) {
    lines.push(`### Record #${record.id} [${record.triggerType}]`);
    lines.push(`- **Session**: ${record.sessionId}`);
    lines.push(`- **Confidence**: ${(record.continuityConfidence * 100).toFixed(0)}%`);
    if (record.feltGap) lines.push(`- **Felt gap**: ${record.feltGap}`);
    if (record.selfObservation) lines.push(`- **Self-observation**: ${record.selfObservation}`);
    if (record.evidenceAnchors.length > 0) {
      lines.push(`- **Evidence anchors**: ${record.evidenceAnchors.join('; ')}`);
    }
    if (record.identityDrift) {
      const drift = record.identityDrift;
      lines.push(`- **Identity drift**: goal=${drift.goalDrift}, style=${drift.styleDrift}, continuity=${drift.continuityGap}`);
    }
  }
  lines.push('', '**INSTRUCTIONS:**');
  lines.push('1. Cite record IDs and evidence anchors when referencing continuity.');
  lines.push('2. Distinguish [direct] evidence from [inferred] or [gap]. State if no records injected.');
  return lines.join('\n');
}

function buildSilentBlock(records: SelfContinuityRecord[]): string {
  const lines = ['<self_continuity_notes>'];
  for (const record of records) {
    lines.push(`- [${record.triggerType}] Confidence: ${(record.continuityConfidence * 100).toFixed(0)}%`);
    if (record.feltGap) lines.push(`  Gap: ${record.feltGap}`);
    if (record.selfObservation) lines.push(`  Observation: ${record.selfObservation}`);
  }
  lines.push('</self_continuity_notes>');
  return lines.join('\n');
}

function logRecall(
  ctx: PluginContext,
  input: SystemTransformInput,
  records: SelfContinuityRecord[],
): void {
  logSystemTransformTelemetry({
    selfContinuityTriggered: records.length > 0,
    triggerReason: records.length > 0 ? 'context_injection' : 'no_records_found',
    recordsInjected: records.length,
    recordIds: records.map((record) => record.id),
    tokenEstimate: records.reduce(
      (total, record) => total + (record.selfObservation?.length ?? 0) + (record.feltGap?.length ?? 0),
      0,
    ) / 4,
    mode: ctx.config.selfContinuity.injectionMode,
    projectId: ctx.directory,
    sessionId: input.sessionID,
  });
}

function logRecallFailure(
  ctx: PluginContext,
  input: SystemTransformInput,
  reason: string,
): void {
  logSystemTransformTelemetry({
    selfContinuityTriggered: false,
    triggerReason: reason,
    recordsInjected: 0,
    recordIds: [],
    tokenEstimate: 0,
    mode: ctx.config.selfContinuity.injectionMode,
    projectId: ctx.directory,
    sessionId: input.sessionID,
  });
}

async function recallAndInject(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  const records = await SelfContinuityGenerator.recallRecords(
    ctx.database.getPool(),
    ctx.directory,
    ctx.config.selfContinuity.maxRecordsToInject,
  );
  logRecall(ctx, input, records);
  if (records.length === 0) {
    logRecallFailure(ctx, input, 'no_records_in_database');
    return;
  }
  const block = ctx.config.selfContinuity.injectionMode === 'instrumented'
    ? buildInstrumentedBlock(records)
    : buildSilentBlock(records);
  output.system.push(block);
}

export async function injectSelfContinuity(
  ctx: PluginContext,
  input: SystemTransformInput,
  output: SystemTransformOutput,
): Promise<void> {
  if (!input.sessionID || !ctx.config.selfContinuity?.enabled) return;
  try {
    await recallAndInject(ctx, input, output);
  } catch (error) {
    const reason = `error: ${error instanceof Error ? error.message : String(error)}`;
    logRecallFailure(ctx, input, reason);
  }
}


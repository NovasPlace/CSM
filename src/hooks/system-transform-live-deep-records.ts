import type { CrossSessionCausalStitcher } from '../cross-session-causal-stitcher.js';
import type { FailureTrace } from '../failure-trace-types.js';
import type { CausalThreadHydrator } from '../self-continuity-causal-thread.js';
import type { HydratedSelfContinuityRecord } from '../self-continuity-hydrator.js';
import { estimateDeepTokens } from './system-transform-live-deep-types.js';

async function appendHydratedRecord(
  lines: string[],
  record: HydratedSelfContinuityRecord,
  hydrator: CausalThreadHydrator,
  sessionId: string,
): Promise<void> {
  lines.push(`### Record #${record.recordId} [${record.triggerType}] confidence=${(record.confidenceScore * 100).toFixed(0)}%`);
  if (record.selfObservation) lines.push(`Self-observation: ${record.selfObservation}`);
  if (record.evidenceAnchors?.length) {
    lines.push(`Evidence anchors [direct]: ${record.evidenceAnchors.join('; ')}`);
  }
  if (record.continuityGap) lines.push(`Continuity gap [gap]: ${record.continuityGap}`);
  if (record.driftSummary) lines.push(`Drift summary: ${record.driftSummary}`);
  const thread = await hydrator.hydrateCausalThread({
    memoryId: record.recordId,
    sessionId,
    radius: 5,
  });
  if (thread) {
    lines.push('Causal thread:');
    for (const node of thread.thread) {
      lines.push(`  [${node.linkType ?? 'temporal'}] ${node.role}: ${node.summary}`);
      if (node.evidenceAnchors?.length) lines.push(`    anchors: ${node.evidenceAnchors.join('; ')}`);
    }
    if (thread.gaps?.length) lines.push(`  gaps [gap]: ${thread.gaps.join('; ')}`);
    if (thread.reconstructionSummary) lines.push(`  reconstruction: ${thread.reconstructionSummary}`);
  }
  lines.push('');
}

export async function appendHydratedRecords(
  lines: string[],
  records: HydratedSelfContinuityRecord[],
  hydrator: CausalThreadHydrator,
  sessionId: string,
  initialTokens: number,
  maxTokens: number,
): Promise<number> {
  if (records.length === 0) {
    lines.push('Hydrated records: none available in database.', '');
    return initialTokens;
  }
  lines.push('## Deep Continuity — Hydrated Records + Causal Threads', '');
  let tokensUsed = initialTokens;
  for (const record of records) {
    if (tokensUsed > maxTokens) break;
    await appendHydratedRecord(lines, record, hydrator, sessionId);
    tokensUsed += estimateDeepTokens(lines.join('\n'));
  }
  return tokensUsed;
}

function appendFailureTrace(
  lines: string[],
  trace: FailureTrace,
  stitcher: CrossSessionCausalStitcher,
): void {
  const stitched = stitcher.stitchFailureTrace(trace, []);
  lines.push(`### Trace: ${trace.problem}`);
  for (const link of stitched.links) {
    const source = link.sourceSessionId ?? '?';
    const target = link.targetSessionId ?? '?';
    lines.push(`- [${link.linkType ?? 'temporal'}] ${source}→${target}`);
    if (link.evidenceAnchors?.length) {
      lines.push(`  evidence [direct]: ${link.evidenceAnchors.join('; ')}`);
    }
    if (link.gapKind) lines.push(`  gap [gap]: ${link.gapKind}`);
  }
  if (stitched.growthEvidence) {
    lines.push(`- [growth] ${stitched.growthEvidence.changedBehaviorSummary}`);
    if (stitched.growthEvidence.evidenceAnchor) {
      lines.push(`  evidence [direct]: ${stitched.growthEvidence.evidenceAnchor}`);
    }
  }
  lines.push('');
}

export function appendFailureTraces(
  lines: string[],
  traces: FailureTrace[],
  stitcher: CrossSessionCausalStitcher,
  initialTokens: number,
  maxTokens: number,
): number {
  if (traces.length === 0 || initialTokens >= maxTokens) {
    if (initialTokens < maxTokens) lines.push('Failure traces: none available in database.', '');
    return initialTokens;
  }
  lines.push('## Failure → Correction → Lesson → Behavior-Change Chains', '');
  let tokensUsed = initialTokens;
  for (const trace of traces) {
    if (tokensUsed > maxTokens) break;
    appendFailureTrace(lines, trace, stitcher);
    tokensUsed += estimateDeepTokens(lines.join('\n'));
  }
  return tokensUsed;
}


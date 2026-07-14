import type { CrossSessionLinkInput } from '../cross-session-causal-types.js';
import type { CausalThreadHydrator } from '../self-continuity-causal-thread.js';
import type { HydratedSelfContinuityRecord } from '../self-continuity-hydrator.js';

export async function collectGrowthChains(
  records: HydratedSelfContinuityRecord[],
  hydrator: CausalThreadHydrator,
  sessionId: string,
): Promise<string[]> {
  const growth: string[] = [];
  for (const record of records) {
    const thread = await hydrator.hydrateCausalThread({
      memoryId: record.recordId,
      sessionId,
      radius: 5,
    });
    if (!thread) continue;
    const lessons = thread.thread.filter((node) => node.role === 'lesson');
    const decisions = thread.thread.filter((node) => node.role === 'decision');
    for (const lesson of lessons) {
      const decision = decisions[0];
      if (decision) {
        growth.push(`lesson → decision_change: ${lesson.summary} → ${decision.summary}`);
      }
    }
  }
  return growth;
}

export function appendGrowthChains(
  lines: string[],
  growth: string[],
  tokensUsed: number,
  maxTokens: number,
): void {
  if (growth.length > 0 && tokensUsed < maxTokens) {
    lines.push('## Growth Evidence Chains', '');
    for (const chain of growth) lines.push(`- [direct] ${chain}`);
    lines.push('');
  } else if (tokensUsed < maxTokens) {
    lines.push('Growth evidence: no lesson→behavior_change chains found in hydrated records.', '');
  }
}

export function appendEvidenceSummary(
  lines: string[],
  records: HydratedSelfContinuityRecord[],
  links: CrossSessionLinkInput[],
): string[] {
  const anchors = [
    ...records.flatMap((record) => record.evidenceAnchors ?? []),
    ...links.flatMap((link) => link.evidenceAnchors ?? []),
  ];
  const uniqueAnchors = [...new Set(anchors)];
  if (uniqueAnchors.length > 0) {
    lines.push(`Total evidence anchors: ${uniqueAnchors.length}`);
  } else {
    lines.push('Evidence anchors: none available. Cross-session links are inferred or gap-filled, not directly anchored to stored memories.');
  }
  lines.push('');
  return uniqueAnchors;
}

export function appendDeepInstructions(
  lines: string[],
  tokensUsed: number,
  maxTokens: number,
): void {
  if (tokensUsed > maxTokens) {
    lines.push(`⚠ Chain truncated at token budget (${maxTokens}). Some layers omitted.`, '');
  }
  lines.push('**DEEP CONTINUITY MODE:**');
  lines.push('1. Use hydrated records, failure traces, and causal threads. Label links [direct]/[inferred]/[gap].');
  lines.push('2. Cite evidence anchors; state gaps explicitly. Note if chain truncated at budget.');
}


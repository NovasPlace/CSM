import { tool } from '@opencode-ai/plugin/tool';
import type { BeliefKnowledgeConsolidator } from './belief-knowledge-store.js';

export function beliefKnowledgeTool(consolidator: BeliefKnowledgeConsolidator) {
  return tool({
    description: 'View consolidated belief knowledge — preferences, opinions, and worldviews backed by evidence refs. Read-only: no consolidation or mutation performed.',
    args: {
      kind: tool.schema.enum(['preference', 'opinion', 'worldview']).optional().describe('Filter by belief kind'),
    },
    async execute(args, _context) {
      const kind = args.kind;
      const beliefs = kind
        ? await consolidator.getBeliefsByKind(kind)
        : await consolidator.getAllBeliefs();

      if (beliefs.length === 0) {
        return {
          title: 'Belief Knowledge',
          output: 'No belief entries found. Run belief consolidation to populate the knowledge store.',
          metadata: { count: 0 },
        };
      }

      const lines: string[] = [];
      const stances: Record<string, number> = {};
      for (const b of beliefs) {
        const kindLabel = `[${b.beliefKind}]`;
        const stanceEmoji = b.stance === 'supports' ? '+' : b.stance === 'opposes' ? '-' : '~';
        stances[b.stance] = (stances[b.stance] ?? 0) + 1;
        const statusTag = b.status !== 'candidate' ? ` (${b.status})` : '';
        lines.push(
          `${kindLabel} ${stanceEmoji} ${b.subject}: ${b.claim.slice(0, 100)} | conf=${b.confidence.toFixed(2)} uncert=${b.uncertainty.toFixed(2)} contradictions=${b.contradictedCount} evidence=${b.evidenceRefs.length} last=${b.lastReinforcedAt?.slice(0, 10) ?? 'never'}${statusTag}`,
        );
      }

      const summary = `Belief knowledge: ${beliefs.length} entries${kind ? ` (${kind})` : ''} | stances: +${stances.supports ?? 0} -${stances.opposes ?? 0} ~${stances.neutral ?? 0}`;
      lines.unshift(summary);
      lines.push('');

      return {
        title: 'Belief Knowledge',
        output: lines.join('\n'),
        metadata: {
          count: beliefs.length,
          kind: kind ?? 'all',
          stanceBreakdown: stances,
          beliefs: beliefs.map(b => ({
            id: b.id,
            kind: b.beliefKind,
            subject: b.subject,
            claim: b.claim,
            stance: b.stance,
            confidence: b.confidence,
            uncertainty: b.uncertainty,
            evidenceCount: b.evidenceRefs.length,
            contradictedCount: b.contradictedCount,
            lastReinforcedAt: b.lastReinforcedAt,
            status: b.status,
          })),
        },
      };
    },
  });
}
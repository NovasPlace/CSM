import { tool } from '@opencode-ai/plugin/tool';
import type { SelfModelUpdater } from './self-model-updater.js';
import type { CapabilityName } from './types.js';

export function selfModelTool(updater: SelfModelUpdater) {
  return tool({
    description: 'View the system self-model — capability confidence scores, uncertainty, evidence counts, and drift warnings. Read-only: no updates performed.',
    args: {
      capability: tool.schema.string().optional().describe('Filter by specific capability name'),
    },
    async execute(args, _context) {
      const filter = args.capability ? String(args.capability).trim() : null;

      let capabilities = await updater.getAllCapabilities();
      if (filter) {
        const single = await updater.getCapability(filter as CapabilityName);
        capabilities = single ? [single] : [];
      }

      if (capabilities.length === 0) {
        return {
          title: 'Self Model',
          output: 'No self-model capabilities found. Ensure the self_model_capabilities table is initialized.',
          metadata: { count: 0 },
        };
      }

      const lines: string[] = [];
      let anyDrift = false;
      for (const cap of capabilities) {
        const driftMarker = cap.driftWarning ? ' ⚠ DRIFT' : '';
        if (cap.driftWarning) anyDrift = true;
        lines.push(
          `[${cap.capability}] confidence=${cap.confidence.toFixed(3)} uncertainty=${cap.uncertainty.toFixed(3)} successes=${cap.successCount} failures=${cap.failureCount} evidence=${cap.evidenceRefs.length} lastVerified=${cap.lastVerified ?? 'never'}${driftMarker}`,
        );
      }

      const summary = `Self-model has ${capabilities.length} capabilities${anyDrift ? ' with drift warnings' : ''}`;
      lines.unshift(summary);
      lines.push('');

      return {
        title: 'Self Model',
        output: lines.join('\n'),
        metadata: {
          count: capabilities.length,
          capabilities: capabilities.map(c => ({
            capability: c.capability,
            confidence: c.confidence,
            uncertainty: c.uncertainty,
            successCount: c.successCount,
            failureCount: c.failureCount,
            evidenceCount: c.evidenceRefs.length,
            evidenceRefs: c.evidenceRefs,
            driftWarning: c.driftWarning,
            lastVerified: c.lastVerified,
          })),
        },
      };
    },
  });
}

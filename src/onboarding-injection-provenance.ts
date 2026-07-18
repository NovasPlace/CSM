import {
  BUILDER_VERSION,
  computeConfigHash,
  type BuiltContextInjection,
} from './context-injection-contract.js';
import type { OnboardingPacket } from './agent-onboarding.js';

export function buildOnboardingProvenance(
  packet: OnboardingPacket,
  text: string,
): BuiltContextInjection {
  const items = packet.sections.flatMap((section, position) => {
    if (section.provenanceItems?.length) return section.provenanceItems;
    return [{
      layerName: section.section, sourceKind: 'derived_state' as const, sourceId: section.source,
      memoryId: null, position, selectionRank: position, selectionScore: null, selectionReason: null,
      disposition: section.status === 'missing' ? 'omitted' as const : 'injected' as const,
      provenanceGranularity: 'layer' as const, charCount: section.content.length,
      metadata: { status: section.status },
    }];
  });
  return {
    text, injectionKind: 'onboarding', items,
    layers: packet.sections.map((section) => ({
      layerName: section.section, status: section.status === 'missing' ? 'dropped' as const : 'included' as const,
      originalChars: section.content.length, finalChars: section.content.length,
      itemCount: section.provenanceItems?.length ?? 1,
      trimReason: section.status === 'missing' ? 'empty_source' : null,
    })),
    charCount: text.length, estimatedTokens: Math.ceil(text.length / 4), trimLevel: 'none',
    builderVersion: BUILDER_VERSION,
    configHash: computeConfigHash({ providerCount: packet.sections.length }),
    metadata: { projectId: packet.projectId, sessionId: packet.sessionId },
  };
}

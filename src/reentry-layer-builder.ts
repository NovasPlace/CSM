import type { LayerBuildResult, ReentryLayerDependencies } from './reentry-layer-types.js';
import {
  buildGoalsLayer,
  buildIdentityLayer,
  buildPreferencesLayer,
  buildWorkLayer,
} from './reentry-layers-primary.js';
import {
  buildBeliefsLayer,
  buildCapabilitiesLayer,
  buildConstraintsLayer,
  buildRecentLayer,
} from './reentry-layers-secondary.js';

export class ReentryLayerBuilder {
  private readonly deps: ReentryLayerDependencies;

  constructor(deps: ReentryLayerDependencies) {
    this.deps = deps;
  }

  hasSource(layerName: string): boolean {
    if (layerName === 'identity') return Boolean(this.deps.pool);
    if (['goals', 'preferences', 'recent', 'constraints'].includes(layerName)) {
      return Boolean(this.deps.memoryManager);
    }
    if (layerName === 'work') return Boolean(this.deps.workJournal && this.deps.memoryManager);
    if (layerName === 'capabilities') return Boolean(this.deps.selfModel);
    if (layerName === 'beliefs') return Boolean(this.deps.beliefStore);
    return true;
  }

  build(layerName: string, sessionId: string, projectId: string): Promise<LayerBuildResult> {
    if (layerName === 'identity') return buildIdentityLayer(this.deps.pool, sessionId, projectId);
    if (layerName === 'goals') return buildGoalsLayer(this.deps.memoryManager, projectId);
    if (layerName === 'work') {
      return buildWorkLayer(this.deps.pool, this.deps.memoryManager, sessionId, projectId);
    }
    if (layerName === 'preferences') return buildPreferencesLayer(this.deps.memoryManager, projectId);
    if (layerName === 'capabilities') return buildCapabilitiesLayer(this.deps.selfModel);
    if (layerName === 'beliefs') return buildBeliefsLayer(this.deps.beliefStore);
    if (layerName === 'recent') return buildRecentLayer(this.deps.memoryManager, projectId);
    if (layerName === 'constraints') return buildConstraintsLayer(this.deps.memoryManager, projectId);
    return Promise.resolve({ text: '', sources: [] });
  }
}

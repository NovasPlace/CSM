import { MemoryManager as BaseMemoryManager } from './memory-manager-base.js';
import type { Memory, MemorySaveOptions } from './types.js';

/**
 * Public MemoryManager facade.
 *
 * Complete provenance metadata field-by-field before delegating to the legacy
 * implementation. Caller-supplied provenance values always win, while missing
 * fields receive the same defaults used for fully-unannotated memories.
 */
export class MemoryManager extends BaseMemoryManager {
  override async saveMemory(options: MemorySaveOptions): Promise<Memory> {
    const currentMeta = options.metadata ?? {};
    const completedOptions: MemorySaveOptions = {
      ...options,
      metadata: {
        source_kind: options.source === 'auto' ? 'transcript' : 'user_supplied',
        evidence_strength: 'direct_original',
        source_session_id: options.sessionId,
        source_agent_id: 'opencode',
        source_model_id: 'default',
        source_surface: 'opencode',
        ...currentMeta,
      },
    };

    return super.saveMemory(completedOptions);
  }
}

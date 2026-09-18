import { MemoryManager as BaseMemoryManager } from './memory-manager-base.js';

/**
 * Public MemoryManager facade.
 *
 * Persistence policy, including provenance completion, lives in the base
 * implementation so every caller follows the same write path.
 */
export class MemoryManager extends BaseMemoryManager {}

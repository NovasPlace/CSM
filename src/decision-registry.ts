/**
 * DecisionRegistry — durable decisions with scope.
 *
 * Uses `type='preference'` memories with structured metadata:
 *   - scope: 'global' | 'project' | 'file' | 'feature' | 'test'
 *   - scope_target: file path, feature name, etc.
 *   - decided_by: 'user' | 'agent' | 'joint'
 *   - rationale: why this decision was made
 *   - reversible: boolean
 *
 * No auto-save of imperative language. Saves explicit user decisions
 * only, or creates a candidate for the agent to confirm.
 */

import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { MemorySaveOptions, Memory, MemoryListOptions } from './types.js';

export type DecisionScope = 'global' | 'project' | 'file' | 'feature' | 'test';

export interface SaveDecisionParams {
  content: string;
  scope: DecisionScope;
  scopeTarget?: string;
  decidedBy?: 'user' | 'agent' | 'joint';
  rationale?: string;
  reversible?: boolean;
  importance?: number;
  tags?: string[];
  sessionId?: string;
  projectId?: string;
}

export interface DecisionRecord {
  memoryId: number;
  content: string;
  scope: DecisionScope;
  scopeTarget?: string;
  decidedBy: string;
  rationale?: string;
  reversible: boolean;
  createdAt: string;
}

export class DecisionRegistry {
  private log = getLogger();

  constructor(private memoryManager: MemoryManager) {}

  async save(params: SaveDecisionParams): Promise<DecisionRecord> {
    const tags = [...new Set(['decision', `scope:${params.scope}`, ...(params.tags ?? [])])];
    if (params.scopeTarget) {
      tags.push(`target:${params.scopeTarget}`);
    }

    const metadata: Record<string, unknown> = {
      source_kind: 'decision',
      scope: params.scope,
      scope_target: params.scopeTarget ?? null,
      decided_by: params.decidedBy ?? 'user',
      rationale: params.rationale ?? null,
      reversible: params.reversible ?? true,
      decided_at: new Date().toISOString(),
    };

    const saveOpts: MemorySaveOptions = {
      content: params.content,
      type: 'preference',
      importance: params.importance ?? 0.8,
      source: 'manual',
      tags,
      metadata,
      sessionId: params.sessionId,
      projectId: params.projectId,
    };

    const memory = await this.memoryManager.saveMemory(saveOpts);

    this.log.info(
      `decision saved: [${params.scope}] ${params.content.slice(0, 60)} (id=${memory.id})`,
    );

    return {
      memoryId: memory.id,
      content: params.content,
      scope: params.scope,
      scopeTarget: params.scopeTarget,
      decidedBy: params.decidedBy ?? 'user',
      rationale: params.rationale,
      reversible: params.reversible ?? true,
      createdAt: String(memory.createdAt),
    };
  }

  async getForFile(filePath: string, projectId?: string): Promise<DecisionRecord[]> {
    const opts: MemoryListOptions = {
      type: 'preference',
      entityType: 'file',
      entityValue: filePath,
      tags: ['decision'],
      limit: 10,
      sortBy: 'recent',
    };
    if (projectId) opts.projectId = projectId;

    const memories = await this.memoryManager.listMemories(opts);
    return memories.map(m => this.toRecord(m));
  }

  async getByFileTag(filePath: string, projectId?: string): Promise<DecisionRecord[]> {
    const allOpts: MemoryListOptions = {
      type: 'preference',
      tags: ['decision'],
      limit: 50,
      sortBy: 'recent',
    };
    if (projectId) allOpts.projectId = projectId;

    const memories = await this.memoryManager.listMemories(allOpts);
    const tag = `target:${filePath}`;
    return memories
      .filter(m => (m.tags ?? []).includes(tag))
      .map(m => this.toRecord(m));
  }

  async getForProject(projectId: string): Promise<DecisionRecord[]> {
    const opts: MemoryListOptions = {
      type: 'preference',
      tags: ['decision'],
      projectId,
      limit: 20,
      sortBy: 'recent',
    };

    const memories = await this.memoryManager.listMemories(opts);
    return memories.map(m => this.toRecord(m));
  }

  async getGlobal(): Promise<DecisionRecord[]> {
    const opts: MemoryListOptions = {
      type: 'preference',
      tags: ['decision', 'scope:global'],
      tagsMatch: 'all',
      searchMode: 'global',
      limit: 20,
      sortBy: 'recent',
    };

    const memories = await this.memoryManager.listMemories(opts);
    return memories
      .filter((memory) => {
        const tags = memory.tags ?? [];
        const scope = (memory.metadata as Record<string, unknown> | undefined)?.scope;
        return tags.includes('decision')
          && tags.includes('scope:global')
          && (scope === undefined || scope === 'global');
      })
      .map(m => this.toRecord(m));
  }

  async searchDecisions(query: string, projectId?: string): Promise<DecisionRecord[]> {
    const opts: MemoryListOptions = {
      type: 'preference',
      tags: ['decision'],
      limit: 10,
      sortBy: 'important',
    };
    if (projectId) opts.projectId = projectId;

    const memories = await this.memoryManager.listMemories(opts);

    const lowerQuery = query.toLowerCase();
    return memories
      .filter(m => m.content.toLowerCase().includes(lowerQuery))
      .map(m => this.toRecord(m));
  }

  private toRecord(m: Memory): DecisionRecord {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      memoryId: m.id,
      content: m.content,
      scope: (meta.scope as DecisionScope) ?? 'global',
      scopeTarget: (meta.scope_target as string) ?? undefined,
      decidedBy: (meta.decided_by as string) ?? 'user',
      rationale: (meta.rationale as string) ?? undefined,
      reversible: (meta.reversible as boolean) ?? true,
      createdAt: String(m.createdAt),
    };
  }
}

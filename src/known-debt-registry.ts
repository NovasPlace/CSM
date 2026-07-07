/**
 * KnownDebtRegistry — track known technical debt as structured memories.
 *
 * Stores debt entries as `type='lesson'` with `metadata.source_kind='known_debt'`.
 * Scopes: project, file, test, command.
 *
 * Debt is explicit: a failing test, a known gap, or a stale contract.
 * The agent registers debt after confirming it (not auto-detected from
 * single bash output — requires explicit register() call).
 *
 * Dedup via signature hash. last_seen updates on re-confirmation,
 * no duplicate spam.
 */

import { createHash } from 'node:crypto';
import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { Memory, MemorySaveOptions, MemoryListOptions } from './types.js';

export type DebtScope = 'project' | 'file' | 'test' | 'command';
export type DebtStatus = 'open' | 'resolved' | 'stale';

export interface RegisterDebtParams {
  description: string;
  scope: DebtScope;
  scopeTarget?: string;
  evidenceCommand?: string;
  signature?: string;
  resolutionHint?: string;
  importance?: number;
  sessionId?: string;
  projectId?: string;
}

export interface DebtRecord {
  memoryId: number;
  description: string;
  scope: DebtScope;
  scopeTarget?: string;
  status: DebtStatus;
  signature: string;
  evidenceCommand?: string;
  resolutionHint?: string;
  firstSeen: string;
  lastSeen: string;
  confirmedCount: number;
}

export class KnownDebtRegistry {
  private log = getLogger();

  constructor(private memoryManager: MemoryManager) {}

  async register(params: RegisterDebtParams): Promise<DebtRecord> {
    const sig = params.signature ?? this.computeSignature(params);
    const existing = await this.findBySignature(sig);

    if (existing) {
      return this.updateLastSeen(existing.memoryId, existing);
    }

    const now = new Date().toISOString();
    const tags = [...new Set(['known-debt', `scope:${params.scope}`])];
    if (params.scopeTarget) {
      tags.push(`target:${params.scopeTarget}`);
    }

    const metadata: Record<string, unknown> = {
      source_kind: 'known_debt',
      scope: params.scope,
      scope_target: params.scopeTarget ?? null,
      status: 'open',
      signature: sig,
      evidence_command: params.evidenceCommand ?? null,
      resolution_hint: params.resolutionHint ?? null,
      first_seen: now,
      last_seen: now,
      confirmed_count: 1,
    };

    const saveOpts: MemorySaveOptions = {
      content: params.description,
      type: 'lesson',
      importance: params.importance ?? 0.7,
      source: 'manual',
      tags,
      metadata,
      sessionId: params.sessionId,
      projectId: params.projectId,
    };

    const memory = await this.memoryManager.saveMemory(saveOpts);
    this.log.info(`debt registered: [${params.scope}] ${params.description.slice(0, 60)} (id=${memory.id})`);

    return this.toRecord(memory);
  }

  async resolve(signature: string): Promise<boolean> {
    const existing = await this.findBySignature(signature);
    if (!existing) return false;

    await this.memoryManager.updateMemoryMetadata(existing.memoryId, {
      status: 'resolved',
      last_seen: new Date().toISOString(),
    });

    this.log.info(`debt resolved: ${existing.description.slice(0, 60)}`);
    return true;
  }

  async getOpenForFile(filePath: string, projectId?: string): Promise<DebtRecord[]> {
    const all = await this.getAll(projectId);
    const tag = `target:${filePath}`;
    return all
      .filter(d => d.status === 'open')
      .filter(d => d.scopeTarget === filePath || (d as { tags?: string[] }).tags?.includes(tag))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  async getOpen(projectId?: string): Promise<DebtRecord[]> {
    const all = await this.getAll(projectId);
    return all.filter(d => d.status === 'open');
  }

  private async getAll(projectId?: string): Promise<DebtRecord[]> {
    const opts: MemoryListOptions = {
      type: 'lesson',
      tags: ['known-debt'],
      limit: 50,
      sortBy: 'recent',
    };
    if (projectId) opts.projectId = projectId;

    const memories = await this.memoryManager.listMemories(opts);
    return memories.map(m => this.toRecord(m));
  }

  private async findBySignature(signature: string): Promise<DebtRecord | null> {
    const all = await this.getAll();
    return all.find(d => d.signature === signature) ?? null;
  }

  private async updateLastSeen(memoryId: number, existing: DebtRecord): Promise<DebtRecord> {
    const now = new Date().toISOString();
    const newCount = existing.confirmedCount + 1;

    await this.memoryManager.updateMemoryMetadata(memoryId, {
      last_seen: now,
      confirmed_count: newCount,
    });

    return { ...existing, lastSeen: now, confirmedCount: newCount };
  }

  private computeSignature(params: RegisterDebtParams): string {
    const parts = [params.scope, params.scopeTarget ?? '', params.description].join('|');
    return createHash('sha256').update(parts).digest('hex').slice(0, 16);
  }

  private toRecord(m: Memory): DebtRecord {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      memoryId: m.id,
      description: m.content,
      scope: (meta.scope as DebtScope) ?? 'project',
      scopeTarget: (meta.scope_target as string) ?? undefined,
      status: (meta.status as DebtStatus) ?? 'open',
      signature: (meta.signature as string) ?? '',
      evidenceCommand: (meta.evidence_command as string) ?? undefined,
      resolutionHint: (meta.resolution_hint as string) ?? undefined,
      firstSeen: (meta.first_seen as string) ?? String(m.createdAt),
      lastSeen: (meta.last_seen as string) ?? String(m.createdAt),
      confirmedCount: (meta.confirmed_count as number) ?? 1,
    };
  }
}
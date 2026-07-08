/**
 * MilestoneTracker — detect significant completion moments and prompt.
 *
 * Detects when real work landed:
 *   - git commit detected in bash output (strongest signal)
 *   - todowrite with status='completed' on high-priority todos
 *   - test pass confirmed after edits
 *
 * Prompts only — no silent persistence. The agent decides whether to save.
 * Deduped by commit hash + files + test count. A re-prompt within a window
 * is suppressed unless the signature changes.
 *
 * Storage: type='lesson' with metadata.source_kind='milestone',
 * structured with scope, commit, tests, files_changed,
 * decision_links, debt_links, summary.
 */

import { createHash } from 'node:crypto';
import { getLogger } from './logger.js';
import type { MemoryManager } from './memory-manager.js';
import type { MemorySaveOptions, Memory, MemoryListOptions } from './types.js';

export type MilestoneScope = 'project' | 'feature' | 'file';

export interface MilestoneEvidence {
  commitHash?: string;
  testsPassed?: number;
  testsTotal?: number;
  lintWarnings?: number;
  lintErrors?: number;
  filesChanged: string[];
  changedFileCount: number;
  citedUserText?: string;
}

export interface MilestonePromptBlock {
  signature: string;
  evidence: MilestoneEvidence;
  formatted: string;
  dedupedFrom?: string;
}

export interface SaveMilestoneParams {
  summary: string;
  scope?: MilestoneScope;
  scopeTarget?: string;
  commit?: string;
  tests?: string;
  filesChanged?: string[];
  decisionLinks?: number[];
  debtLinks?: number[];
  importance?: number;
  sessionId?: string;
  projectId?: string;
}

export interface SavedMilestone {
  memoryId: number;
  summary: string;
  scope: MilestoneScope;
  scopeTarget?: string;
  commit?: string;
  tests?: string;
  filesChanged: string[];
  decisionLinks: number[];
  debtLinks: number[];
  savedAt: string;
}

const DEDUP_WINDOW_MS = 5 * 60 * 1000; // 5 min
const MAX_PROMPTS_PER_SESSION = 3;

const STRONG_USER_HINTS = /\b(complete|completed|landed|final state|phase done|shipped|done with|finished|locked in|green light|this is the one)\b/i;

export class MilestoneTracker {
  private log = getLogger();
  private lastPromptSignature: string | null = null;
  private lastPromptAt = 0;
  private promptsThisSession = 0;
  private pendingCommitHash: string | null = null;
  private lastTestResults: { passed?: number; total?: number } | null = null;
  private lastLintResults: { warnings?: number; errors?: number } | null = null;

  constructor(private memoryManager: MemoryManager) {}

  detectFromBashOutput(cmd: string, output: string): MilestonePromptBlock | null {
    if (!cmd || !output) return null;

    const commitHash = this.extractCommitHash(output);
    if (commitHash) {
      this.pendingCommitHash = commitHash;
    }

    const testMatch = output.match(/(?:tests?.*?):?\s*(\d+)\s*(?:pass|passed)/i)
      ?? output.match(/(?:pass|passed)\s*(\d+)/i)
      ?? output.match(/pass\s+(\d+)/i);
    if (testMatch && /test/i.test(cmd)) {
      this.lastTestResults = {
        passed: +testMatch[1],
      };
      const totalMatch = output.match(/(?:tests?|total)\s*(\d+)/i);
      if (totalMatch) this.lastTestResults.total = +totalMatch[1];
    }

    const lintMatch = output.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i);
    if (lintMatch && /lint|eslint/i.test(cmd)) {
      this.lastLintResults = {
        errors: +lintMatch[2],
        warnings: +lintMatch[3],
      };
    }

    if (!commitHash) return null;

    return this.tryEmit({
      commitHash,
      filesChanged: [],
      changedFileCount: 0,
      testsPassed: this.lastTestResults?.passed,
      testsTotal: this.lastTestResults?.total,
      lintWarnings: this.lastLintResults?.warnings,
      lintErrors: this.lastLintResults?.errors,
    });
  }

  detectFromTodoUpdate(args: unknown, userText?: string): MilestonePromptBlock | null {
    const todos = (args as { todos?: Array<{ status?: string; priority?: string; content?: string }> })?.todos;
    if (!Array.isArray(todos)) return null;

    const anyCompletedHigh = todos.some(
      t => t.status === 'completed' && (t.priority === 'high' || t.priority === 'medium'),
    );
    if (!anyCompletedHigh) return null;

    if (!userText || !STRONG_USER_HINTS.test(userText)) return null;

    return this.tryEmit({
      citedUserText: userText.slice(0, 120),
      filesChanged: [],
      changedFileCount: 0,
      commitHash: this.pendingCommitHash ?? undefined,
      testsPassed: this.lastTestResults?.passed,
      testsTotal: this.lastTestResults?.total,
    });
  }

  private tryEmit(evidence: MilestoneEvidence): MilestonePromptBlock | null {
    const signature = this.computeSignature(evidence);

    if (this.lastPromptSignature === signature
      && (Date.now() - this.lastPromptAt) < DEDUP_WINDOW_MS) {
      return null;
    }

    if (this.promptsThisSession >= MAX_PROMPTS_PER_SESSION) {
      return null;
    }

    this.lastPromptSignature = signature;
    this.lastPromptAt = Date.now();
    this.promptsThisSession++;

    return {
      signature,
      evidence,
      formatted: this.formatPrompt(evidence),
    };
  }

  async save(params: SaveMilestoneParams): Promise<SavedMilestone> {
    const now = new Date().toISOString();
    const metadata: Record<string, unknown> = {
      source_kind: 'milestone',
      scope: params.scope ?? 'project',
      scope_target: params.scopeTarget ?? null,
      commit: params.commit ?? null,
      tests: params.tests ?? null,
      files_changed: params.filesChanged ?? [],
      decision_links: params.decisionLinks ?? [],
      debt_links: params.debtLinks ?? [],
      saved_at: now,
      signature: createHash('sha256')
        .update(`${params.commit ?? ''}|${params.summary}|${(params.filesChanged ?? []).join(',')}`)
        .digest('hex').slice(0, 16),
    };

    const saveOpts: MemorySaveOptions = {
      content: params.summary,
      type: 'lesson',
      importance: params.importance ?? 0.8,
      source: 'manual',
      tags: ['milestone', `scope:${params.scope ?? 'project'}`, ...(params.scopeTarget ? [`target:${params.scopeTarget}`] : [])],
      metadata,
      sessionId: params.sessionId,
      projectId: params.projectId,
    };

    const memory = await this.memoryManager.saveMemory(saveOpts);
    this.log.info(`milestone saved: "${params.summary.slice(0, 60)}" (id=${memory.id}, commit=${params.commit ?? 'none'})`);

    return {
      memoryId: memory.id,
      summary: params.summary,
      scope: params.scope ?? 'project',
      scopeTarget: params.scopeTarget,
      commit: params.commit,
      tests: params.tests,
      filesChanged: params.filesChanged ?? [],
      decisionLinks: params.decisionLinks ?? [],
      debtLinks: params.debtLinks ?? [],
      savedAt: now,
    };
  }

  async getMilestonesForFile(filePath: string, projectId?: string): Promise<SavedMilestone[]> {
    const tag = `target:${filePath}`;
    const opts: MemoryListOptions = {
      type: 'lesson',
      tags: ['milestone', 'scope:file'],
      limit: 10,
      sortBy: 'recent',
    };
    if (projectId) opts.projectId = projectId;

    const memories = await this.memoryManager.listMemories(opts);
    return memories
      .filter(m => (m.tags ?? []).includes(tag))
      .map(m => this.toRecord(m));
  }

  private extractCommitHash(output: string): string | null {
    const m = output.match(/(?:\[|\b)([0-9a-f]{7,40})(?:\])/);
    return m ? m[1] : null;
  }

  private computeSignature(evidence: MilestoneEvidence): string {
    const parts = [
      evidence.commitHash ?? '',
      evidence.citedUserText ?? '',
      evidence.changedFileCount.toString(),
      evidence.testsPassed?.toString() ?? '',
      evidence.lintWarnings?.toString() ?? '',
    ].join('|');
    return createHash('sha256').update(parts).digest('hex').slice(0, 16);
  }

  private formatPrompt(evidence: MilestoneEvidence): string {
    const lines: string[] = ['## Milestone candidate detected'];

    if (evidence.commitHash) {
      lines.push(`- commit: ${evidence.commitHash}`);
    }
    if (evidence.filesChanged.length > 0) {
      lines.push(`- files changed (${evidence.filesChanged.length}): ${evidence.filesChanged.slice(0, 5).join(', ')}`);
    }
    if (evidence.testsTotal || evidence.testsPassed) {
      lines.push(`- tests passed: ${evidence.testsPassed ?? 'unknown'}${evidence.testsTotal ? ` / ${evidence.testsTotal}` : ''}`);
    }
    if (evidence.lintWarnings !== undefined) {
      lines.push(`- lint: ${evidence.lintWarnings} warnings${evidence.lintErrors !== undefined ? `, ${evidence.lintErrors} errors` : ''}`);
    }
    if (evidence.citedUserText) {
      lines.push(`- user hint: "${evidence.citedUserText}"`);
    }

    lines.push('');
    lines.push('If this was a significant checkpoint, save it:');
    lines.push('  csm_memory_save(type="lesson", tags=["milestone","scope:project"], ...)');
    lines.push('Otherwise dismiss — no automatic persistence.');

    return lines.join('\n');
  }

  private toRecord(m: Memory): SavedMilestone {
    const meta = (m.metadata ?? {}) as Record<string, unknown>;
    return {
      memoryId: m.id,
      summary: m.content,
      scope: (meta.scope as MilestoneScope) ?? 'project',
      scopeTarget: (meta.scope_target as string) ?? undefined,
      commit: (meta.commit as string) ?? undefined,
      tests: (meta.tests as string) ?? undefined,
      filesChanged: (meta.files_changed as string[]) ?? [],
      decisionLinks: (meta.decision_links as number[]) ?? [],
      debtLinks: (meta.debt_links as number[]) ?? [],
      savedAt: (meta.saved_at as string) ?? String(m.createdAt),
    };
  }
}
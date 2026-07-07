/**
 * FileContextPrimer — context-on-touch for files.
 *
 * When an agent reads or edits a file, this module:
 *   1. Fetches prior decisions scoped to that file
 *   2. Fetches relevant lessons that mention the file
 *   3. Formats a compact advisory block (max 500 chars)
 *   4. Sets it on session state for system-transform to inject
 *
 * Gated: skips under token pressure (capTrimLevel >= 'tight').
 * Deduped: skips if same file was injected within last N tool calls.
 */

import type { DecisionRegistry } from './decision-registry.js';
import type { MemoryManager } from './memory-manager.js';
import type { MemoryListOptions } from './types.js';

const MAX_CHARS = 500;
const DEDUP_WINDOW = 5;

export interface FileContextBlock {
  filePath: string;
  decisions: Array<{ content: string; scope: string }>;
  lessons: Array<{ content: string }>;
  formatted: string;
}

export class FileContextPrimer {
  private lastInjectedFile: string | null = null;
  private callsSinceLastInject = 0;

  constructor(
    private decisions: DecisionRegistry,
    private memories: MemoryManager,
  ) {}

  async buildBlock(
    filePath: string,
    projectId?: string,
  ): Promise<FileContextBlock | null> {
    if (this.shouldSkip(filePath)) return null;

    const [fileDecisions, fileLessons] = await Promise.all([
      this.fetchDecisions(filePath, projectId),
      this.fetchLessons(filePath),
    ]);

    if (fileDecisions.length === 0 && fileLessons.length === 0) return null;

    const formatted = this.format(filePath, fileDecisions, fileLessons);
    this.lastInjectedFile = filePath;
    this.callsSinceLastInject = 0;

    return {
      filePath,
      decisions: fileDecisions,
      lessons: fileLessons,
      formatted,
    };
  }

  tickCall(): void {
    this.callsSinceLastInject++;
  }

  private shouldSkip(filePath: string): boolean {
    if (this.lastInjectedFile === filePath && this.callsSinceLastInject < DEDUP_WINDOW) {
      return true;
    }
    return false;
  }

  private async fetchDecisions(
    filePath: string,
    projectId?: string,
  ): Promise<Array<{ content: string; scope: string }>> {
    try {
      let records = await this.decisions.getForFile(filePath, projectId);
      if (records.length === 0) {
        records = await this.decisions.getByFileTag(filePath, projectId);
      }
      return records.map(r => ({ content: r.content, scope: r.scope }));
    } catch {
      return [];
    }
  }

  private async fetchLessons(filePath: string): Promise<Array<{ content: string }>> {
    try {
      const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
      const opts: MemoryListOptions = {
        type: 'lesson',
        limit: 5,
        sortBy: 'important',
      };
      const memories = await this.memories.listMemories(opts);
      return memories
        .filter(m => m.content.includes(fileName) || m.content.includes(filePath))
        .map(m => ({ content: m.content }));
    } catch {
      return [];
    }
  }

  private format(
    filePath: string,
    decisions: Array<{ content: string; scope: string }>,
    lessons: Array<{ content: string }>,
  ): string {
    const fileName = filePath.split(/[\\/]/).pop() ?? filePath;
    const lines: string[] = [`## Prior Context for ${fileName}`];

    for (const d of decisions.slice(0, 3)) {
      const tag = d.scope === 'file' ? 'decision' : `decision (${d.scope})`;
      lines.push(`- ${this.truncate(d.content, 120)} [${tag}]`);
    }

    for (const l of lessons.slice(0, 2)) {
      lines.push(`- ${this.truncate(l.content, 120)} [lesson]`);
    }

    const result = lines.join('\n');
    if (result.length > MAX_CHARS) {
      return result.slice(0, MAX_CHARS - 3) + '...';
    }
    return result;
  }

  private truncate(s: string, limit: number): string {
    return s.length <= limit ? s : s.slice(0, limit - 3) + '...';
  }
}

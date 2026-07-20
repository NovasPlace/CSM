import { tool } from '@opencode-ai/plugin/tool';
import type { MemoryManager } from './memory-manager.js';
import type { Database } from './database.js';

const MAX_CHARS = parseInt(process.env.VCM_MAX_CHARS ?? '300', 10);
const MAX_PAGES = parseInt(process.env.VCM_MAX_PAGES ?? '4', 10);
const MIN_IMPORTANCE = parseFloat(process.env.VCM_MIN_IMPORTANCE ?? '0.3');

interface VcmPage {
  memoryId: number;
  content: string;
  type: string;
  importance: number;
  tags: string[];
}

interface VcmWorkingSet {
  pages: VcmPage[];
  totalChars: number;
  memoryIds: number[];
}

export class VcmManager {
  constructor(private mm: MemoryManager, private db: Database) {}

  async buildContextBlock(sessionId: string, projectId: string): Promise<string> {
    try {
      const ws = await this.buildWorkingSet(projectId, sessionId);
      return this.formatBlock(ws);
    } catch {
      return '';
    }
  }

  private async buildWorkingSet(projectId: string, _sessionId: string): Promise<VcmWorkingSet> {
    let memories = await this.mm.listMemories({ projectId, sortBy: 'accessed', limit: MAX_PAGES * 2 });
    if (memories.length === 0) {
      memories = await this.mm.listMemories({
        projectId,
        searchMode: 'legacy',
        sortBy: 'recent',
        limit: MAX_PAGES,
      });
    }

    const pages: VcmPage[] = [];
    let totalChars = 0;

    for (const mem of memories) {
      if (mem.importance < MIN_IMPORTANCE) continue;
      const text = this.truncate(mem.content, MAX_CHARS - totalChars);
      if (text.length === 0) break;

      pages.push({
        memoryId: mem.id,
        content: text,
        type: mem.memoryType,
        importance: mem.importance,
        tags: mem.tags ?? [],
      });

      totalChars += text.length;
      if (pages.length >= MAX_PAGES || totalChars >= MAX_CHARS) break;
    }

    return { pages, totalChars, memoryIds: pages.map(p => p.memoryId) };
  }

  private truncate(text: string, budget: number): string {
    if (text.length <= budget) return text;
    return text.slice(0, budget - 3) + '...';
  }

  private formatBlock(ws: VcmWorkingSet): string {
    if (ws.pages.length === 0) return '';
    const lines = [
      '## Working Memory (VCM)',
      `  ${ws.pages.length} recent entries (${ws.totalChars} chars):`,
    ];
    for (const p of ws.pages) {
      lines.push(`  [id:${p.memoryId}] (${p.type}, imp:${p.importance.toFixed(2)}) ${p.content}`);
    }
    lines.push('');
    lines.push('To get full detail on any entry: call context_fault with the memory_id.');
    return '\n' + lines.join('\n');
  }

  faultTool() {
    const db = this.db;
    const mm = this.mm;

    return tool({
      description: 'Fetch the full content, chunks, and related memories for a specific memory ID from the VCM working set. Use this when you see an [id:N] reference in Working Memory and need deeper context.',
      args: {
        memory_id: tool.schema.number().describe('The memory ID to fetch full detail for (from [id:N] in Working Memory).'),
        with_related: tool.schema.boolean().optional().describe('Also fetch linked/related memory IDs. Default false.'),
        max_related: tool.schema.number().optional().describe('Max related memories to return (1-20, default 5).'),
      },
      async execute(args, _context) {
        const memoryId = typeof args.memory_id === 'number' ? args.memory_id : Number(args.memory_id);
        if (!memoryId || memoryId < 1) {
          return { title: 'Context Fault', output: 'Error: memory_id must be a positive integer.', metadata: {} };
        }
        try {
          const mem = await mm.getMemory(memoryId);
          if (!mem) {
            return { title: 'Context Fault', output: `Memory ${memoryId} not found.`, metadata: {} };
          }

          const pool = db.getPool();
          const chunkResult = await pool.query(
            'SELECT chunk_index, content FROM memory_chunks WHERE memory_id = $1 ORDER BY chunk_index',
            [memoryId],
          );

          const lines = [
            `## Memory ${mem.id}`,
            `Type: ${mem.memoryType} | Importance: ${mem.importance.toFixed(2)}`,
            `Tags: ${(mem.tags ?? []).join(', ') || 'none'}`,
            `Created: ${String(mem.createdAt)}`,
            '',
            mem.content,
          ];

          const chunks = chunkResult.rows as Array<{ chunk_index: number; content: string }>;
          if (chunks.length > 0) {
            lines.push('', `### Chunks (${chunks.length})`);
            for (const c of chunks) {
              lines.push(`  [${c.chunk_index}] ${c.content.slice(0, 500)}${c.content.length > 500 ? '...' : ''}`);
            }
          }

          return {
            title: `Context Fault: ${mem.id}`,
            output: lines.join('\n'),
            metadata: { memoryId: mem.id, type: mem.memoryType, importance: mem.importance, tags: mem.tags, chunkCount: chunks.length },
          };
        } catch (err) {
          return { title: 'Context Fault', output: `Error: ${(err as Error).message}`, metadata: {} };
        }
      },
    });
  }
}

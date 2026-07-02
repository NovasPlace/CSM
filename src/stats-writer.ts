import { writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import { nowFn, dialectFromPool } from './db/query-dialect.js';

export type CsmMemory = {
  id: number;
  title: string;
  type: string;
  source: string;
  sessionId: string | null;
  createdAt: string;
  importance: number;
  confidence: number;
  emotion: string;
  tags: string[];
  linkedMemoryIds: number[];
  relatedFiles: string[];
  relatedTools: string[];
  turnId: string | null;
};

export type CsmStats = {
  version: 3;
  updatedAt: string;
  memoryCount: number;
  recentSessions24h: number;
  compactions24h: number;
  tokensSaved24h: number;
  lastCompactionAt: string | null;
  contextPressure: number;
  lastCheckpointAt: string | null;
  recentMemories: CsmMemory[];
  injectedContext: {
    brief: string;
    episodicCount: number;
    proceduralCount: number;
    semanticCount: number;
    builtAt: string;
    sessionId: string;
  } | null;
};

function defaultStatsPath(): string {
  const env = process.env.OPENCODE_CSM_STATS_PATH;
  if (env) return env;
  if (platform() === 'win32') {
    const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'ai.opencode.desktop', 'csm-stats.json');
  }
  return join(homedir(), '.config', 'opencode', 'csm-stats.json');
}

function titleFromContent(content: string, type: string, source: string): string {
  const t = content.trim();
  if (source === 'subconscious' || (type === 'episodic' && (t.startsWith('[modified]') || t.startsWith('[assistant]')))) {
    return t.split('\n')[0].slice(0, 80);
  }
  const stripped = t.replace(/^\[(user|assistant|system|tool)\]\s*/i, '');
  return stripped.split('\n')[0].slice(0, 80) || t.slice(0, 40);
}

function safeArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return [];
}

function extractFiles(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const m = meta as Record<string, unknown>;
  const files = new Set<string>();
  for (const key of ['files', 'changedFiles', 'affectedFiles', 'relatedFiles']) {
    const arr = m[key];
    if (Array.isArray(arr)) arr.forEach((f) => { if (typeof f === 'string') files.add(f); });
  }
  const entities = m.entities;
  if (Array.isArray(entities)) {
    entities.forEach((e: unknown) => {
      if (e && typeof e === 'object' && (e as Record<string, unknown>).type === 'file') {
        const v = (e as Record<string, unknown>).value;
        if (typeof v === 'string') files.add(v);
      }
    });
  }
  return [...files].slice(0, 5);
}

function extractTools(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return [];
  const m = meta as Record<string, unknown>;
  const tools = new Set<string>();
  const entities = m.entities;
  if (Array.isArray(entities)) {
    entities.forEach((e: unknown) => {
      if (e && typeof e === 'object' && (e as Record<string, unknown>).type === 'tool') {
        const v = (e as Record<string, unknown>).value;
        if (typeof v === 'string') tools.add(v);
      }
    });
  }
  for (const key of ['tools', 'triggerTools']) {
    const arr = m[key];
    if (Array.isArray(arr)) arr.forEach((t) => { if (typeof t === 'string') tools.add(t); });
  }
  return [...tools].slice(0, 5);
}

function extractBrief(text: string): string {
  const lines = text.split('\n');
  let collected = '';
  for (const line of lines) {
    if (collected.length + line.length > 600) break;
    collected += (collected ? '\n' : '') + line;
  }
  return collected.trim();
}

export class StatsWriter {
  private filePath: string;
  private pool: DatabasePool;
  private logger = getLogger();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(pool: DatabasePool, filePath?: string) {
    this.pool = pool;
    this.filePath = filePath ?? defaultStatsPath();
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.write();
    this.timer = setInterval(() => this.write(), intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async write(): Promise<void> {
    try {
      type RowN = { n: number };
      type RowCkpt = { created_at: string };
      type RowComp = { created_at: string };

       const [memResult, sessResult, ckptResult, compResult, tokResult, lastCompResult] = await Promise.all([
         this.pool.query("SELECT COUNT(*)::int AS n FROM memories"),
         this.pool.query(`SELECT COUNT(*)::int AS n FROM sessions WHERE updated_at > ${nowFn(dialectFromPool(this.pool))} - interval '24 hours'`),
         this.pool.query("SELECT created_at FROM checkpoints ORDER BY created_at DESC LIMIT 1"),
         this.pool.query(`SELECT COUNT(*)::int AS n FROM compaction_metrics WHERE created_at > ${nowFn(dialectFromPool(this.pool))} - interval '24 hours'`),
         this.pool.query(`SELECT COALESCE(SUM(tokens_saved), 0)::int AS n FROM compaction_metrics WHERE created_at > ${nowFn(dialectFromPool(this.pool))} - interval '24 hours'`),
         this.pool.query("SELECT created_at FROM compaction_metrics ORDER BY created_at DESC LIMIT 1"),
       ]);

      const recentMemResult = await this.pool.query(
        `SELECT id, left(content, 500) AS content, memory_type, source, session_id,
                created_at, importance, COALESCE(confidence, 1.0) AS confidence,
                COALESCE(emotion, 'neutral') AS emotion, tags, linked_memory_ids,
                metadata, turn_id
         FROM memories ORDER BY created_at DESC LIMIT 10`,
      );

      const ctxResult = await this.pool.query(
        `SELECT session_id, context_brief, episodic_memories, procedural_memories,
                semantic_memories, built_at
         FROM session_contexts ORDER BY built_at DESC LIMIT 1`,
      );

      let injectedContext: CsmStats['injectedContext'] = null;
      if (ctxResult.rows.length > 0) {
        const ctxRow = ctxResult.rows[0] as Record<string, unknown>;
        injectedContext = {
          brief: extractBrief((ctxRow.context_brief as string) ?? ''),
          episodicCount: Array.isArray(ctxRow.episodic_memories) ? ctxRow.episodic_memories.length : 0,
          proceduralCount: Array.isArray(ctxRow.procedural_memories) ? ctxRow.procedural_memories.length : 0,
          semanticCount: Array.isArray(ctxRow.semantic_memories) ? ctxRow.semantic_memories.length : 0,
          builtAt: (ctxRow.built_at as string) ?? '',
          sessionId: (ctxRow.session_id as string) ?? '',
        };
      }

      const stats: CsmStats = {
        version: 3,
        updatedAt: new Date().toISOString(),
        memoryCount: (memResult.rows[0] as RowN | undefined)?.n ?? 0,
        recentSessions24h: (sessResult.rows[0] as RowN | undefined)?.n ?? 0,
        compactions24h: (compResult.rows[0] as RowN | undefined)?.n ?? 0,
        tokensSaved24h: (tokResult.rows[0] as RowN | undefined)?.n ?? 0,
        lastCompactionAt: (lastCompResult.rows[0] as RowComp | undefined)?.created_at
          ? new Date((lastCompResult.rows[0] as RowComp).created_at).toISOString()
          : null,
        contextPressure: 0,
        lastCheckpointAt: (ckptResult.rows[0] as RowCkpt | undefined)?.created_at
          ? new Date((ckptResult.rows[0] as RowCkpt).created_at).toISOString()
          : null,
        recentMemories: recentMemResult.rows.map((r: unknown) => {
          const row = r as Record<string, unknown>;
          const raw = (row.content as string) ?? '';
          const memType = row.memory_type as string;
          const memSource = (row.source as string) ?? 'manual';
          const tags = safeArray(row.tags);
          const linkedIds = Array.isArray(row.linked_memory_ids)
            ? (row.linked_memory_ids as number[]).map(Number)
            : [];
          const meta = row.metadata;
          return {
            id: row.id as number,
            title: titleFromContent(raw, memType, memSource),
            type: memType,
            source: memSource,
            sessionId: (row.session_id as string) ?? null,
            createdAt: row.created_at as string,
            importance: Number(row.importance ?? 0.5),
            confidence: Number(row.confidence ?? 1.0),
            emotion: (row.emotion as string) ?? 'neutral',
            tags,
            linkedMemoryIds: linkedIds,
            relatedFiles: extractFiles(meta),
            relatedTools: extractTools(meta),
            turnId: (row.turn_id as string) ?? null,
          };
        }),
        injectedContext,
      };

      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

       const tmpPath = this.filePath + '.tmp';
       writeFileSync(tmpPath, JSON.stringify(stats, null, 2), 'utf-8');
       renameSync(tmpPath, this.filePath);
     } catch (err) {
       this.logger.error('Failed to write stats', err as Error);
     }
   }
 }

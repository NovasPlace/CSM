import type { DatabasePool } from './types.js';
import { redact } from './redactor.js';
import { ilikeLiteralExpr, dialectFromPool } from './db/query-dialect.js';

export type CausalRole =
  | 'problem'
  | 'action'
  | 'result'
  | 'decision'
  | 'lesson'
  | 'downstream_change'
  | 'landmark';

export type CausalLinkType = 'causal' | 'temporal' | 'reference' | 'none';

export interface CausalThreadNode {
  memoryId: number;
  eventType: string;
  role: CausalRole;
  summary: string;
  evidenceAnchors: string[];
  confidence: number;
  timestamp: Date | undefined;
  linkType: CausalLinkType;
}

export interface CausalThreadGap {
  kind: 'missing_reason' | 'missing_result' | 'missing_diff' | 'missing_link' | 'orphan_thread';
  detail: string;
}

export interface CausalThreadResult {
  rootMemoryId: number;
  thread: CausalThreadNode[];
  gaps: CausalThreadGap[];
  confidence: number;
  reconstructionSummary: string;
  budgetExceeded: boolean;
  fallbackUsed: boolean;
}

export type HydratedCausalThread = CausalThreadResult;

export interface HydrateCausalThreadOptions {
  memoryId: number;
  sessionId?: string;
  projectId?: string;
  radius?: number;
  includeToolEvents?: boolean;
  includeDecisions?: boolean;
  includeLessons?: boolean;
  maxTokens?: number;
}

const DEFAULT_RADIUS = 5;
const DEFAULT_MAX_TOKENS = 1200;
const APPROX_CHARS_PER_TOKEN = 4;

const PROBLEM_PATTERNS = [
  /\berror\b/i, /\bfail(ed|ure)?\b/i, /\bbug\b/i, /\bcrash\b/i,
  /\bbroken\b/i, /\bissue\b/i, /\bnot work(ing)?\b/i, /\bexception\b/i,
];
const ACTION_PATTERNS = [
  /\bfix(ed|ing)?\b/i, /\bimplement(ed|ing)?\b/i, /\badd(ed|ing)?\b/i,
  /\brefactor(ed|ing)?\b/i, /\bupdat(ed|ing)?\b/i, /\bbuilt\b/i, /\bcreat(ed|ing)?\b/i,
  /\bedit(ed|ing)?\b/i, /\bcommit(ted|ting)?\b/i,
  /\bpushing\b/i, /\bworking on\b/i,
];
const RESULT_PATTERNS = [
  /\bpass(ed|ing)?\b/i, /\bgreen\b/i, /\bsucce(eded|ssful)?\b/i, /\bwork(s|ing|ed)?\b/i,
  /\bcomplet(ed|e)\b/i, /\block(ed|ing)?\b/i, /\bship(ped|ping)?\b/i, /\bpushed\b/i,
];
const DECISION_PATTERNS = [
  /\bdecision\b/i, /\bdecid(ed|e)\b/i, /\bchose\b/i, /\btrade-?off\b/i,
  /\bwhy\b/i, /\brationale\b/i, /\brule\b/i, /\bpolicy\b/i,
];
const LESSON_PATTERNS = [
  /\blesson\b/i, /\blearn(ed|ing)?\b/i, /\bmistake\b/i, /\bfrustrat/i,
  /\bdetected loop\b/i, /\bLESSON:\b/i,
];
const DOWNSTREAM_PATTERNS = [
  /\bdownstream\b/i, /\bbecause of\b/i, /\bdue to\b/i, /\bcaused by\b/i,
  /\bresulted in\b/i, /\bso that\b/i, /\bin order to\b/i,
];

export function classifyRole(content: string, type?: string): CausalRole {
  const text = content ?? '';
  if (type === 'lesson' || LESSON_PATTERNS.some(p => p.test(text))) return 'lesson';
  if (type === 'decision' || DECISION_PATTERNS.some(p => p.test(text))) return 'decision';
  if (DOWNSTREAM_PATTERNS.some(p => p.test(text))) return 'downstream_change';
  if (RESULT_PATTERNS.some(p => p.test(text))) return 'result';
  if (ACTION_PATTERNS.some(p => p.test(text))) return 'action';
  if (PROBLEM_PATTERNS.some(p => p.test(text))) return 'problem';
  return 'landmark';
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / APPROX_CHARS_PER_TOKEN);
}

export class CausalThreadHydrator {
  private pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.pool = pool;
  }

  async hydrateCausalThread(opts: HydrateCausalThreadOptions): Promise<CausalThreadResult> {
    const radius = opts.radius ?? DEFAULT_RADIUS;
    const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
    const includeToolEvents = opts.includeToolEvents ?? true;
    const includeDecisions = opts.includeDecisions ?? true;
    const includeLessons = opts.includeLessons ?? true;

    try {
      const root = await this.fetchMemory(opts.memoryId);
      if (!root) {
        return this.emptyResult(opts.memoryId, ['orphan_thread']);
      }

      const linked = await this.fetchLinkedMemories(opts.memoryId, radius);
      const temporal = opts.sessionId
        ? await this.fetchTemporalNeighbors(opts.memoryId, opts.sessionId, radius)
        : [];

      const decisions = includeDecisions ? await this.fetchAdjacentDecisions(opts.memoryId, radius) : [];
      const lessons = includeLessons ? await this.fetchAdjacentLessons(opts.memoryId, radius) : [];

      const seen = new Set<number>();
      const nodes: CausalThreadNode[] = [];

      const addNode = (
        memoryId: number,
        content: string,
        type: string | undefined,
        timestamp: Date | undefined,
        linkType: CausalLinkType,
        evidenceAnchors: string[],
      ) => {
        if (seen.has(memoryId)) return;
        if (memoryId !== opts.memoryId && !includeToolEvents && type === 'tool') return;
        seen.add(memoryId);
        const safeContent = redact(content ?? '').text ?? content ?? '';
        nodes.push({
          memoryId,
          eventType: type ?? 'memory',
          role: classifyRole(content ?? '', type),
          summary: safeContent.slice(0, 220),
          evidenceAnchors,
          confidence: linkType === 'causal' ? 0.8 : linkType === 'temporal' ? 0.4 : 0.5,
          timestamp,
          linkType,
        });
      };

      addNode(root.id, root.content, root.type, root.created_at, 'none', [`memory:${root.id}`]);

      for (const link of linked) {
        addNode(link.id, link.content, link.type, link.created_at, link.linkType, link.evidenceAnchors);
      }

      for (const t of temporal) {
        if (!seen.has(t.id)) {
          addNode(t.id, t.content, t.type, t.created_at, 'temporal', []);
        }
      }

      for (const d of decisions) {
        if (!seen.has(d.id)) {
          addNode(d.id, d.content, 'decision', d.created_at, 'reference', [`decision:${d.id}`]);
        }
      }

      for (const l of lessons) {
        if (!seen.has(l.id)) {
          addNode(l.id, l.content, 'lesson', l.created_at, 'reference', [`lesson:${l.id}`]);
        }
      }

      nodes.sort((a, b) => {
        const at = a.timestamp?.getTime() ?? 0;
        const bt = b.timestamp?.getTime() ?? 0;
        return at - bt;
      });

      const gaps = this.detectGaps(nodes);
      const { thread, budgetExceeded } = this.applyBudget(nodes, maxTokens);
      const confidence = this.computeConfidence(thread, gaps);
      const summary = this.buildSummary(opts.memoryId, thread, gaps, confidence);

      return {
        rootMemoryId: opts.memoryId,
        thread,
        gaps,
        confidence,
        reconstructionSummary: summary,
        budgetExceeded,
        fallbackUsed: false,
      };
    } catch {
      return this.emptyResult(opts.memoryId, ['missing_link']);
    }
  }

  private async fetchMemory(id: number) {
    const result = await this.pool.query(
      `SELECT id, content, type, session_id, project_id, created_at
       FROM memories WHERE id = $1`,
      [id],
    );
    return result.rows[0] as
      | { id: number; content: string; type: string; session_id: string; project_id: string; created_at: Date }
      | undefined;
  }

  private async fetchLinkedMemories(rootId: number, radius: number) {
    const result = await this.pool.query(
      `WITH RECURSIVE chain AS (
        SELECT m.id, m.content, m.type, m.created_at, ml.link_type, 1 AS depth
        FROM memory_links ml
        JOIN memories m ON m.id = ml.to_memory_id
        WHERE ml.from_memory_id = $1
        UNION ALL
        SELECT m.id, m.content, m.type, m.created_at, ml.link_type, c.depth + 1
        FROM chain c
        JOIN memory_links ml ON ml.from_memory_id = c.id
        JOIN memories m ON m.id = ml.to_memory_id
        WHERE c.depth < $2
      )
      SELECT DISTINCT ON (id) id, content, type, created_at, link_type
      FROM chain
      WHERE id != $1
      ORDER BY id, created_at`,
      [rootId, radius],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as number,
      content: row.content as string,
      type: row.type as string,
      created_at: row.created_at as Date,
      linkType: (row.link_type === 'causal' ? 'causal' : row.link_type === 'temporal' ? 'temporal' : 'reference') as CausalLinkType,
      evidenceAnchors: [`link:${row.link_type ?? 'unknown'}:${row.id}`],
    }));
  }

  private async fetchTemporalNeighbors(rootId: number, sessionId: string, radius: number) {
    const result = await this.pool.query(
      `SELECT m.id, m.content, m.type, m.created_at
       FROM memories m
       WHERE m.session_id = $1
       AND m.id != $2
       ORDER BY ABS(EXTRACT(EPOCH FROM (m.created_at - (
         SELECT created_at FROM memories WHERE id = $2
       ))))
       LIMIT $3`,
      [sessionId, rootId, radius],
    );
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as number,
      content: row.content as string,
      type: row.type as string,
      created_at: row.created_at as Date,
    }));
  }

  private async fetchAdjacentDecisions(rootId: number, radius: number) {
    try {
      const d = dialectFromPool(this.pool);
      const result = await this.pool.query(
        `SELECT id, content, created_at FROM memories
         WHERE (${ilikeLiteralExpr(d, 'content', '%decision%')} OR ${ilikeLiteralExpr(d, 'content', '%decided%')} OR ${ilikeLiteralExpr(d, 'content', '%trade-off%')})
         AND id != $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [rootId, Math.min(radius, 3)],
      );
      return (result.rows as Record<string, unknown>[]).map((row) => ({
        id: row.id as number,
        content: row.content as string,
        created_at: row.created_at as Date,
      }));
    } catch {
      return [];
    }
  }

  private async fetchAdjacentLessons(rootId: number, radius: number) {
    try {
      const result = await this.pool.query(
        `SELECT id, content, created_at FROM memories
         WHERE type = 'lesson'
         AND id != $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [rootId, Math.min(radius, 3)],
      );
      return (result.rows as Record<string, unknown>[]).map((row) => ({
        id: row.id as number,
        content: row.content as string,
        created_at: row.created_at as Date,
      }));
    } catch {
      return [];
    }
  }

  private detectGaps(nodes: CausalThreadNode[]): CausalThreadGap[] {
    const gaps: CausalThreadGap[] = [];
    const roles = new Set(nodes.map(n => n.role));

    const causalLinks = nodes.filter(n => n.linkType === 'causal').length;
    if (causalLinks === 0 && nodes.length > 1) {
      gaps.push({ kind: 'missing_link', detail: 'adjacent memories are temporally ordered but no explicit causal link connects them' });
    }

    const hasResult = roles.has('result');
    const hasProblem = roles.has('problem');
    const hasAction = roles.has('action');

    if (hasProblem && !hasAction) {
      gaps.push({ kind: 'missing_reason', detail: 'problem present but no recorded action that addressed it' });
    }
    if (hasAction && !hasResult) {
      gaps.push({ kind: 'missing_result', detail: 'action present but no recorded result confirming success or failure' });
    }
    if (nodes.length === 1) {
      gaps.push({ kind: 'orphan_thread', detail: 'root memory has no neighbors, links, lessons, or decisions' });
    }

    const mentionsDiff = nodes.some(n => /\bdiff\b|\bedit(ed|ing)?\b|\bpatch\b/i.test(n.summary));
    if (hasAction && !mentionsDiff) {
      gaps.push({ kind: 'missing_diff', detail: 'action node present but no explicit file change/edit recorded in the thread' });
    }

    return gaps;
  }

  private applyBudget(nodes: CausalThreadNode[], maxTokens: number): {
    thread: CausalThreadNode[];
    budgetExceeded: boolean;
  } {
    const thread: CausalThreadNode[] = [];
    let used = 0;
    let exceeded = false;
    for (const node of nodes) {
      const cost = approxTokens(node.summary);
      if (used + cost > maxTokens) {
        exceeded = true;
        break;
      }
      thread.push(node);
      used += cost;
    }
    return { thread, budgetExceeded: exceeded };
  }

  private computeConfidence(thread: CausalThreadNode[], gaps: CausalThreadGap[]): number {
    const causal = thread.filter(n => n.linkType === 'causal').length;
    const total = thread.length;
    if (total === 0) return 0;
    const causalRatio = causal / total;
    const gapPenalty = Math.min(gaps.length * 0.12, 0.5);
    return Math.max(0.05, Math.min(0.95, 0.5 + causalRatio * 0.4 - gapPenalty));
  }

  private buildSummary(rootId: number, thread: CausalThreadNode[], gaps: CausalThreadGap[], confidence: number): string {
    const roleOrder: CausalRole[] = ['problem', 'action', 'result', 'decision', 'lesson', 'downstream_change', 'landmark'];
    const byRole = new Map<CausalRole, CausalThreadNode[]>();
    for (const n of thread) {
      const arr = byRole.get(n.role) ?? [];
      arr.push(n);
      byRole.set(n.role, arr);
    }
    const lines: string[] = [`[Causal Thread around #${rootId}]`];
    for (const role of roleOrder) {
      const arr = byRole.get(role);
      if (!arr || arr.length === 0) continue;
      lines.push(`${role}:`);
      for (const n of arr) {
        lines.push(`  - #${n.memoryId} (${n.linkType}, conf ${n.confidence.toFixed(2)}): ${n.summary}`);
      }
    }
    if (gaps.length > 0) {
      lines.push('gaps:');
      for (const g of gaps) lines.push(`  - ${g.kind}: ${g.detail}`);
    }
    lines.push(`confidence: ${confidence.toFixed(2)}`);
    return lines.join('\n');
  }

  private emptyResult(rootId: number, gapKinds: string[]): CausalThreadResult {
    const gaps: CausalThreadGap[] = gapKinds.map(k => ({ kind: 'missing_link' as const, detail: k }));
    if (gapKinds.includes('orphan_thread')) {
      gaps[0] = { kind: 'orphan_thread', detail: 'root memory not found or no neighbors' };
    }
    return {
      rootMemoryId: rootId,
      thread: [],
      gaps,
      confidence: 0,
      reconstructionSummary: `[Causal Thread around #${rootId}]\nNo causal thread available. Gaps: ${gapKinds.join(', ')}`,
      budgetExceeded: false,
      fallbackUsed: true,
    };
  }
}

export async function hydrateCausalThread(
  pool: DatabasePool,
  opts: HydrateCausalThreadOptions,
): Promise<CausalThreadResult> {
  const hydrator = new CausalThreadHydrator(pool);
  return hydrator.hydrateCausalThread(opts);
}

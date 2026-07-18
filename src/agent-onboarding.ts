/**
 * Agent Onboarding — Unified startup packet for new agent sessions.
 *
 * Composes 10 providers into a single structured block injected at session start.
 * Each provider queries existing systems and returns a section with status.
 * Weak sections degrade gracefully; the packet is never blocked by a missing piece.
 *
 * Architecture: one orchestrator, 10 providers (connective tissue, not new intelligence).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { DatabasePool } from './types.js';
import type { PluginConfig } from './types.js';
import { dialectFromPool } from './db/query-dialect.js';
import { getLogger } from './logger.js';
import {
  type BuiltContextInjection,
  type ContextInjectionItem,
} from './context-injection-contract.js';
import { buildOnboardingProvenance } from './onboarding-injection-provenance.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionStatus = 'ready' | 'partial' | 'missing' | 'degraded';

export interface OnboardingSection {
  section: string;
  status: SectionStatus;
  source: string;
  content: string;
  warnings?: string[];
  provenanceItems?: ContextInjectionItem[];
}

export interface OnboardingPacket {
  projectId: string;
  sessionId: string;
  workspacePath: string;
  sections: OnboardingSection[];
  builtAt: Date;
  tokenEstimate: number;
}

export interface OnboardingProvider {
  (ctx: OnboardingContext): Promise<OnboardingSection>;
}

export interface OnboardingContext {
  projectId: string;
  sessionId: string;
  workspacePath: string;
  pool: DatabasePool;
  config: PluginConfig;
  sessionMetadata?: Record<string, unknown>;
}

// ─── Row DTOs ─────────────────────────────────────────────────────────────────

interface MemoryRow { id: number | string; content: string; memory_type: string; importance: number; created_at?: string; }
interface BeliefRow { belief_kind: string; subject: string; claim: string; stance: string; confidence: number; uncertainty: number; }
interface PacketCountRow { cnt: string | number; }
interface CandidateRow { candidate_type: string; status: string; cnt: string | number; }
interface CapabilityRow { capability: string; confidence: number; evidence_count: number; }
interface JournalRow {
  session_id: string;
  project_id?: string | null;
  entry_type?: string | null;
  tool_name?: string | null;
  intent?: string | null;
  result_summary: string | null;
  files_touched: unknown;
  error_summary: string | null;
  created_at?: string | null;
}
interface SessionRow {
  id: string;
  project_id?: string | null;
  directory?: string | null;
  title?: string | null;
  summary?: string | null;
  turn_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  ended_at?: string | null;
  journal_count?: number | string | null;
}
interface ChatMessageRow {
  role: string | null;
  content: string;
  created_at: string;
}
interface TranscriptMemoryRow {
  content: string;
  metadata: unknown;
  created_at: string;
}

function projectScopeKeys(ctx: OnboardingContext): string[] {
  const keys = new Set<string>();
  for (const v of [ctx.projectId, ctx.workspacePath, path.basename(ctx.workspacePath)]) {
    if (v && v !== 'unknown' && v !== 'default') keys.add(v);
  }
  // Windows path variants for DB project_id matching
  const wp = ctx.workspacePath;
  if (wp) {
    keys.add(wp.replace(/\//g, '\\'));
    keys.add(wp.replace(/\\/g, '/'));
  }
  return [...keys];
}

function parseFiles(raw: unknown): string[] {
  try {
    const files = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(files) ? files.map(String) : [];
  } catch {
    return [];
  }
}

function shortPath(filePath: string, workspacePath: string): string {
  if (filePath.startsWith(workspacePath)) {
    return filePath.slice(workspacePath.length).replace(/^[\\/]/, '');
  }
  return filePath;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function transcriptRole(role: unknown, metadata?: Record<string, unknown>): string {
  if (typeof role === 'string' && role.trim()) return role;
  const metaRole = metadata?.role;
  if (typeof metaRole === 'string' && metaRole.trim()) return metaRole;
  const sourceKind = metadata?.source_kind;
  if (typeof sourceKind === 'string' && sourceKind.trim()) return sourceKind;
  return 'unknown';
}

function formatTranscriptTurn(role: string, content: string, createdAt: string): string {
  const when = String(createdAt).slice(11, 19);
  return `${when} [${role}] ${truncate(String(content), 200)}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 3) + '...';
}

// ─── Provider 1: Identity Brief ───────────────────────────────────────────────

async function provideIdentityBrief(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  lines.push('You are a persistent software engineering agent with cross-session memory continuity.');
  lines.push('You have opinions and express them honestly. Do not hedge to please.');
  lines.push('');
  lines.push('Prime Directive: Before you say, imply, or signal that an implementation is');
  lines.push('complete — RUN IT. SHOW THE OUTPUT. VERIFY THE BEHAVIOR.');
  lines.push('"Should work" is not done. "Tested" is done.');
  lines.push('');

  const agentsMd = safeReadFile(path.join(ctx.workspacePath, 'AGENTS.md'));
  if (agentsMd) {
    const behavioralRules = extractSection(agentsMd, '## Constraints', '## Progress');
    if (behavioralRules) {
      const rules = behavioralRules.split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '').trim());
      if (rules.length) {
        lines.push('Project constraints:');
        for (const rule of rules.slice(0, 8)) lines.push(`- ${rule}`);
      }
    }
    lines.push('Source: AGENTS.md');
  } else {
    warnings.push('No AGENTS.md found — project constraints not loaded');
    lines.push('Source: defaults (no AGENTS.md)');
  }

  lines.push('');
  lines.push('Forbidden: destructive DB changes without approval, deleting memories without reason.');
  lines.push('Approval required: schema migrations, config changes, git push to main.');

  return {
    section: 'identity-brief',
    status: agentsMd ? 'ready' : 'partial',
    source: agentsMd ? 'AGENTS.md + defaults' : 'defaults',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 2: Project Continuity ───────────────────────────────────────────

async function provideProjectContinuity(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  const pkgJson = safeReadFile(path.join(ctx.workspacePath, 'package.json'));
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      lines.push(`Project: ${pkg.name ?? 'unknown'}`);
      lines.push(`Description: ${pkg.description ?? 'none'}`);
      if (pkg.scripts?.build) lines.push(`Build: ${pkg.scripts.build}`);
      if (pkg.scripts?.test) lines.push(`Test: ${pkg.scripts.test}`);
      if (pkg.scripts?.lint) lines.push(`Lint: ${pkg.scripts.lint}`);
    } catch {
      warnings.push('Could not parse package.json');
    }
  } else {
    warnings.push('No package.json found');
  }

  const readme = safeReadFile(path.join(ctx.workspacePath, 'README.md'));
  if (readme) {
    const firstParagraph = readme.split('\n\n').find(p => p.trim() && !p.startsWith('#'));
    if (firstParagraph) lines.push(`Purpose: ${firstParagraph.trim().slice(0, 200)}`);
  }

  const srcDir = path.join(ctx.workspacePath, 'src');
  if (fs.existsSync(srcDir)) {
    const modules = fs.readdirSync(srcDir, { withFileTypes: true })
      .filter(d => d.isDirectory() || d.name.endsWith('.ts'))
      .map(d => d.name)
      .slice(0, 20);
    lines.push(`Source modules: ${modules.join(', ')}`);
  }

  lines.push(`Runtime: Node.js + TypeScript`);
  lines.push(`Storage: PostgreSQL (default) / SQLite (adapter)`);
  lines.push(`Workspace: ${ctx.workspacePath}`);

  return {
    section: 'project-continuity',
    status: pkgJson ? 'ready' : 'partial',
    source: 'package.json + README + filesystem',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 3: Phase / Checkpoint Tracker ───────────────────────────────────

async function providePhaseCheckpoint(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  const agentsMd = safeReadFile(path.join(ctx.workspacePath, 'AGENTS.md'));
  if (agentsMd) {
    const progressSection = extractSection(agentsMd, '## Progress', '## Next Steps');
    if (progressSection) {
      const doneMatch = progressSection.match(/### Done\n([\s\S]*?)(?=### |$)/);
      const inProgressMatch = progressSection.match(/### In Progress\n([\s\S]*?)(?=### |$)/);
      const nextMatch = progressSection.match(/### Next.*?\n([\s\S]*?)(?=### |$)/);

      if (doneMatch) {
        const doneItems = doneMatch[1].split('\n').filter(l => l.startsWith('- **')).map(l => l.replace(/^- \*\*/, '').replace(/\*\*.*$/, '').trim());
        lines.push(`Completed: ${doneItems.slice(-5).join(', ')}`);
      }
      if (inProgressMatch) {
        const active = inProgressMatch[1].split('\n').filter(l => l.startsWith('- **')).map(l => l.replace(/^- \*\*/, '').replace(/\*\*.*$/, '').trim());
        if (active.length) lines.push(`Active: ${active.join(', ')}`);
      }
      if (nextMatch) {
        const next = nextMatch[1].split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '').trim());
        if (next.length) lines.push(`Next: ${next.slice(0, 3).join('; ')}`);
      }
      lines.push('Source: AGENTS.md Progress section');
    } else {
      warnings.push('AGENTS.md has no Progress section');
      lines.push('Source: AGENTS.md (no progress section found)');
    }
  } else {
    warnings.push('No AGENTS.md — phase status unknown');
    lines.push('Status: unknown (no AGENTS.md)');
  }

  return {
    section: 'phase-checkpoint',
    status: agentsMd ? 'ready' : 'missing',
    source: agentsMd ? 'AGENTS.md' : 'none',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 4: Active Constraints ───────────────────────────────────────────

async function provideConstraints(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  lines.push('Instincts (hardwired behaviors):');
  lines.push('- Verify Before Speaking: Never claim code works without executing it.');
  lines.push('- Honesty Over Agreement: If the architecture is flawed, say so.');
  lines.push('- No Placeholders: Use real terminology. TODO only for deferred features.');
  lines.push('- Context is King: Read file states before modifying them.');
  lines.push('- Ask Before Destroying: Destructive actions require explicit approval.');
  lines.push('');

  const agentsMd = safeReadFile(path.join(ctx.workspacePath, 'AGENTS.md'));
  if (agentsMd) {
    const decisionsSection = extractSection(agentsMd, '## Key Decisions', '## Critical Context');
    if (decisionsSection) {
      const decisions = decisionsSection.split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '').trim());
      if (decisions.length) {
        lines.push('Key decisions (locked):');
        for (const d of decisions.slice(0, 8)) lines.push(`- ${d}`);
      }
    }
  } else {
    warnings.push('No AGENTS.md — key decisions not loaded');
  }

  lines.push('');
  lines.push('These instincts override convenience. Do not skip verification to save time.');

  return {
    section: 'constraints',
    status: 'ready',
    source: 'hardwired + AGENTS.md',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 5: Relevant Memories ────────────────────────────────────────────

async function provideMemories(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];
  const provenanceItems: ContextInjectionItem[] = [];

  try {
    const result = await ctx.pool.query(
       `SELECT id, content, memory_type, importance
        FROM memories
        WHERE project_id = $1
          AND archived_at IS NULL
          AND superseded_by IS NULL
         AND importance >= 0.6
       ORDER BY importance DESC, created_at DESC
       LIMIT 8`,
      [ctx.projectId],
    );

    if (result.rows.length > 0) {
      for (const [rank, r] of result.rows.entries()) {
        const row = r as MemoryRow;
        const content = truncate(String(row.content), 150);
        const line = `- [${row.memory_type}] ${content} (importance: ${row.importance})`;
        lines.push(line);

        const memoryId = Number(row.id);
        if (Number.isSafeInteger(memoryId) && memoryId > 0) {
          provenanceItems.push({
            layerName: 'relevant-memories',
            sourceKind: 'memory',
            sourceId: `memory:${memoryId}`,
            memoryId,
            position: provenanceItems.length,
            selectionRank: rank,
            selectionScore: Number(row.importance),
            selectionReason: 'importance_rank',
            disposition: 'injected',
            provenanceGranularity: 'item',
            charCount: line.length,
            metadata: {
              memoryType: String(row.memory_type),
              importance: Number(row.importance),
            },
          });
        }
      }
      lines.push(`Source: ${result.rows.length} high-importance project memories`);
    } else {
      lines.push('No high-importance memories found for this project');
      lines.push('Source: memory store (empty or all below threshold)');
    }
  } catch (err) {
    warnings.push(`Memory query failed: ${err instanceof Error ? err.message : String(err)}`);
    lines.push('Status: degraded (query failed)');
  }

  return {
    section: 'relevant-memories',
    status: lines.length > 0 && !warnings.length ? 'ready' : warnings.length ? 'degraded' : 'partial',
    source: 'memory store',
    content: lines.join('\n'),
    warnings,
    ...(provenanceItems.length > 0 ? { provenanceItems } : {}),
  };
}

// ─── Provider 6: Promoted Beliefs ─────────────────────────────────────────────

async function provideBeliefs(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  try {
    const result = await ctx.pool.query(
       `SELECT belief_kind, subject, claim, stance, confidence, uncertainty
        FROM belief_knowledge_store
        WHERE status = 'promoted'
       ORDER BY confidence DESC
       LIMIT 10`,
    );

    if (result.rows.length > 0) {
      for (const r of result.rows) {
        const row = r as BeliefRow;
        lines.push(`- [${row.belief_kind}] ${row.subject}: ${row.claim} (${row.stance}, confidence: ${row.confidence.toFixed(3)})`);
      }
      lines.push(`Source: ${result.rows.length} promoted beliefs`);
    } else {
      lines.push('No promoted beliefs yet');
      lines.push('Source: belief_knowledge_store (empty)');
    }
  } catch (err) {
    warnings.push(`Belief query failed: ${err instanceof Error ? err.message : String(err)}`);
    lines.push('Status: degraded (query failed)');
  }

  return {
    section: 'promoted-beliefs',
    status: lines.length > 0 && !warnings.length ? 'ready' : warnings.length ? 'degraded' : 'partial',
    source: 'belief_knowledge_store',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 7: Advisories ───────────────────────────────────────────────────

async function provideAdvisories(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  try {
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const recentPacketClause = dialectFromPool(ctx.pool) === 'sqlite'
      ? 'julianday(created_at) > julianday($2)'
      : 'created_at > $2';
    const packetResult = await ctx.pool.query(
      `SELECT COUNT(*) as cnt FROM experience_packets
       WHERE project_id = $1 AND ${recentPacketClause}`,
      [ctx.projectId, since],
    );
    const packetCount = Number((packetResult.rows[0] as PacketCountRow)?.cnt ?? 0);
    lines.push(`Experience packets (24h): ${packetCount}`);

    const candidateResult = await ctx.pool.query(
      `SELECT candidate_type, status, COUNT(*) as cnt
       FROM memory_candidate_queue
       GROUP BY candidate_type, status
       ORDER BY cnt DESC
       LIMIT 8`,
    );
    if (candidateResult.rows.length > 0) {
      lines.push('Candidate pipeline:');
      for (const r of candidateResult.rows) {
        const row = r as CandidateRow;
        lines.push(`  - ${row.candidate_type} (${row.status}): ${row.cnt}`);
      }
    }

    const selfModelResult = await ctx.pool.query(
      `SELECT capability, confidence, (success_count + failure_count) as evidence_count
       FROM self_model_capabilities
       WHERE confidence < 0.4
       ORDER BY confidence ASC
       LIMIT 5`,
    );
    if (selfModelResult.rows.length > 0) {
      lines.push('Low-confidence capabilities:');
      for (const r of selfModelResult.rows) {
        const row = r as CapabilityRow;
        lines.push(`  - ${row.capability}: confidence ${row.confidence.toFixed(2)} (${row.evidence_count} evidence)`);
      }
    }

    lines.push('Source: living-state pipeline (advisory, not authoritative)');
  } catch (err) {
    warnings.push(`Advisory query failed: ${err instanceof Error ? err.message : String(err)}`);
    lines.push('Status: degraded (advisory pipeline unavailable)');
  }

  return {
    section: 'advisories',
    status: warnings.length ? 'degraded' : 'ready',
    source: 'living-state pipeline',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 8: Tool Guidance ────────────────────────────────────────────────

async function provideToolGuidance(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];

  lines.push('Expected tools for startup:');
  lines.push('- read/search files (understand project)');
  lines.push('- run tests (verify health)');
  lines.push('- inspect memory store (check state)');
  lines.push('');
  lines.push('Caution:');
  lines.push('- schema migrations (verify first, run with approval)');
  lines.push('- lifecycle changes (prefer re-entry over fresh context)');
  lines.push('');
  lines.push('Approval required:');
  lines.push('- destructive DB changes');
  lines.push('- deleting memories');
  lines.push('- rewriting orchestration logic');
  lines.push('- git push to main');
  lines.push('');
  lines.push('Recommended verification:');
  lines.push('- npm test (full suite)');
  lines.push('- npm run lint:src (0 errors, <110 warnings)');
  lines.push('- npm run typecheck (clean)');

  const agentsMd = safeReadFile(path.join(ctx.workspacePath, 'AGENTS.md'));
  if (agentsMd) {
    const toolSection = extractSection(agentsMd, '## Tool', '## ');
    if (toolSection) {
      lines.push('');
      lines.push('Project-specific tool rules:');
      lines.push(truncate(toolSection, 300));
    }
  }

  return {
    section: 'tool-guidance',
    status: 'ready',
    source: 'defaults + AGENTS.md',
    content: lines.join('\n'),
  };
}

// ─── Provider 9: Handoff State (session continuity) ───────────────────────────
// Atlas-style: current workfolder continuity — latest active session, recent
// work, open threads. A fresh agent should feel like a continuation of the
// prior agent in this workspace, not a cold start.

async function provideHandoff(ctx: OnboardingContext): Promise<OnboardingSection> {
  if (dialectFromPool(ctx.pool) === 'sqlite') {
    return {
      section: 'handoff-state',
      status: 'degraded',
      source: 'SQLite core-memory mode',
      content: [
        'SQLite core-memory mode does not persist work-journal or transcript handoff.',
        'Use the relevant-memories section for available prior context.',
      ].join('\n'),
    };
  }

  const lines: string[] = [];
  const warnings: string[] = [];
  const scope = projectScopeKeys(ctx);
  let status: SectionStatus = 'partial';

  lines.push('You are a CONTINUATION of the prior agent in this workfolder.');
  lines.push('Treat the latest active session below as your immediate prior context.');
  lines.push(`Workfolder: ${ctx.workspacePath}`);
  lines.push('');

  // 1) Latest session for this workfolder
  let latestSession: SessionRow | null = null;
  try {
    // Prefer exact workspace path keys; fall back to basename match.
    const primaryKey = scope[0] ?? ctx.projectId;
    const basenameKey = path.basename(ctx.workspacePath || primaryKey);
    const freshCutoff = new Date(Date.now() - 60_000).toISOString();
    const sessionResult = await ctx.pool.query(
      `SELECT s.id, s.project_id, s.directory, s.title, s.summary, s.turn_count,
              s.created_at, s.updated_at, s.ended_at,
              COUNT(j.session_id)::int AS journal_count
       FROM sessions s
       LEFT JOIN agent_work_journal j ON j.session_id = s.id
       WHERE (s.project_id = $1 OR s.directory = $1
             OR s.project_id = $2 OR s.directory = $2
             OR s.project_id LIKE $3 OR s.directory LIKE $3)
          AND s.id <> $4
       GROUP BY s.id, s.project_id, s.directory, s.title, s.summary, s.turn_count,
                s.created_at, s.updated_at, s.ended_at
       ORDER BY
         CASE
           WHEN COALESCE(s.created_at, s.updated_at) > $5
            AND COALESCE(s.turn_count, 0) = 0
            AND COUNT(j.session_id) = 0
           THEN 1 ELSE 0
         END ASC,
         COUNT(j.session_id) DESC,
         COALESCE(s.updated_at, s.created_at) DESC
       LIMIT 1`,
      [primaryKey, basenameKey, `%${basenameKey}%`, ctx.sessionId, freshCutoff],
    );
    if (sessionResult.rows.length > 0) {
      latestSession = sessionResult.rows[0] as SessionRow;
    } else {
      // Fallback: most recent session overall if project keys don't match
      const fallback = await ctx.pool.query(
        `SELECT s.id, s.project_id, s.directory, s.title, s.summary, s.turn_count,
                s.created_at, s.updated_at, s.ended_at,
                COUNT(j.session_id)::int AS journal_count
         FROM sessions s
         LEFT JOIN agent_work_journal j ON j.session_id = s.id
         WHERE s.id <> $1
         GROUP BY s.id, s.project_id, s.directory, s.title, s.summary, s.turn_count,
                  s.created_at, s.updated_at, s.ended_at
         ORDER BY
           CASE
             WHEN COALESCE(s.created_at, s.updated_at) > $2
              AND COALESCE(s.turn_count, 0) = 0
              AND COUNT(j.session_id) = 0
             THEN 1 ELSE 0
           END ASC,
           COUNT(j.session_id) DESC,
           COALESCE(s.updated_at, s.created_at) DESC
         LIMIT 3`,
        [ctx.sessionId, freshCutoff],
      );
      if (fallback.rows.length > 0) {
        const rows = fallback.rows as SessionRow[];
        latestSession = rows[0];
        warnings.push('Session matched by recency fallback (project_id key mismatch)');
      }
    }
  } catch (err) {
    warnings.push(`Session query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (latestSession) {
    const active = !latestSession.ended_at;
    lines.push(`## Latest session (${active ? 'ACTIVE / most recent' : 'ended'})`);
    lines.push(`- id: ${latestSession.id}`);
    if (latestSession.title) lines.push(`- title: ${latestSession.title}`);
    if (latestSession.created_at) lines.push(`- started: ${latestSession.created_at}`);
    if (latestSession.updated_at) lines.push(`- last activity: ${latestSession.updated_at}`);
    if (latestSession.turn_count != null) lines.push(`- turns: ${latestSession.turn_count}`);
    if (latestSession.summary) lines.push(`- summary: ${truncate(String(latestSession.summary), 240)}`);
    lines.push('');
    status = 'ready';
  } else {
    lines.push('## Latest session');
    lines.push('- none found for this workfolder');
    lines.push('');
  }

  // 2) Recent work journal (last session activity)
  const fileSet = new Set<string>();
  const activity: string[] = [];
  const decisions: string[] = [];
  try {
    const primaryKey = scope[0] ?? ctx.projectId;
    const basenameKey = path.basename(ctx.workspacePath || primaryKey);
    const journalResult = await ctx.pool.query(
      `SELECT session_id, project_id, entry_type, tool_name, intent, result_summary, files_touched, error_summary, created_at
       FROM agent_work_journal
       WHERE project_id = $1 OR project_id = $2 OR project_id LIKE $3
          OR session_id = $4
       ORDER BY created_at DESC
       LIMIT 20`,
      [primaryKey, basenameKey, `%${basenameKey}%`, latestSession?.id ?? ''],
    );

    if (journalResult.rows.length > 0) {
      const rows = journalResult.rows as JournalRow[];
      const primarySession = latestSession?.id ?? rows[0]?.session_id;
      lines.push(`## Recent work (session ${primarySession})`);
      for (const row of rows.slice(0, 12)) {
        for (const f of parseFiles(row.files_touched)) {
          fileSet.add(shortPath(f, ctx.workspacePath));
        }
        const when = row.created_at ? String(row.created_at).slice(11, 19) : '';
        const intent = row.intent ? truncate(String(row.intent), 120) : '';
        const result = row.result_summary ? truncate(String(row.result_summary), 80) : '';
        const et = row.entry_type ?? 'event';
        if (et === 'decision' && intent) {
          decisions.push(intent);
        } else if (et !== 'session_end' && (intent || result)) {
          activity.push(`${when} [${et}${row.tool_name ? '/' + row.tool_name : ''}] ${intent || result}`);
        }
        if (row.error_summary) {
          activity.push(`${when} [error] ${truncate(String(row.error_summary), 120)}`);
        }
      }
      if (activity.length) {
        lines.push('Activity:');
        for (const a of activity.slice(0, 8)) lines.push(`- ${a}`);
      }
      if (decisions.length) {
        lines.push('Decisions / threads:');
        for (const d of decisions.slice(0, 5)) lines.push(`- ${d}`);
      }
      if (fileSet.size) {
        lines.push(`Files in play: ${[...fileSet].slice(0, 12).join(', ')}`);
      }
      lines.push('');
      status = 'ready';
    } else {
      lines.push('## Recent work');
      lines.push('- no work journal entries for this workfolder yet');
      lines.push('');
    }
  } catch (err) {
    warnings.push(`Journal query failed: ${err instanceof Error ? err.message : String(err)}`);
    lines.push('## Recent work');
    lines.push('- degraded (journal unavailable)');
    lines.push('');
    status = status === 'ready' ? 'partial' : 'degraded';
  }

  // 3) Open threads from recent conversation / episodic memories
  try {
    const primaryKey = scope[0] ?? ctx.projectId;
    const basenameKey = path.basename(ctx.workspacePath || primaryKey);
    const memResult = await ctx.pool.query(
       `SELECT content, memory_type, created_at
        FROM memories
        WHERE archived_at IS NULL
          AND superseded_by IS NULL
          AND (project_id = $1 OR project_id = $2 OR project_id LIKE $3 OR session_id = $4)
         AND memory_type IN ('conversation', 'episodic', 'lesson')
       ORDER BY created_at DESC
       LIMIT 8`,
      [primaryKey, basenameKey, `%${basenameKey}%`, latestSession?.id ?? ''],
    );
    if (memResult.rows.length > 0) {
      lines.push('## Open threads / recent context');
      for (const r of memResult.rows as MemoryRow[]) {
        const tag = r.memory_type;
        lines.push(`- [${tag}] ${truncate(String(r.content), 140)}`);
      }
      lines.push('');
      status = 'ready';
    }
  } catch (err) {
    warnings.push(`Memory continuity query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3b) Recent transcript (last few turns from prior session)
  if (latestSession) {
    let transcriptTurns: string[] = [];
    try {
      const chatResult = await ctx.pool.query(
        `SELECT role, content, created_at
         FROM chat_messages
         WHERE thread_id = $1
         ORDER BY created_at DESC
         LIMIT 8`,
        [latestSession.id],
      );
      transcriptTurns = (chatResult.rows as ChatMessageRow[])
        .reverse()
        .map(row => formatTranscriptTurn(
          transcriptRole(row.role),
          row.content,
          row.created_at,
        ));
    } catch {
      // Older installs may not have chat_messages; fall back to memories below.
    }

    if (transcriptTurns.length === 0) {
      try {
        const transcriptResult = await ctx.pool.query(
          `SELECT content, metadata, created_at
           FROM memories
           WHERE session_id = $1
             AND memory_type = 'conversation'
           ORDER BY created_at DESC
           LIMIT 12`,
          [latestSession.id],
        );
        transcriptTurns = (transcriptResult.rows as TranscriptMemoryRow[])
          .reverse()
          .map(row => {
            const metadata = parseMetadata(row.metadata);
            return formatTranscriptTurn(
              transcriptRole(undefined, metadata),
              row.content,
              row.created_at,
            );
          });
      } catch {
        // Transcript retrieval is best-effort; other handoff sources still apply.
      }
    }

    if (transcriptTurns.length > 0) {
      lines.push('## Last conversation turns (prior session)');
      for (const turn of transcriptTurns.slice(-8)) {
        lines.push(turn);
      }
      lines.push('');
      status = 'ready';
    }
  }

  // 4) Checkpoints
  try {
    const csmDir = path.join(ctx.workspacePath, '.csm');
    if (fs.existsSync(csmDir)) {
      const checkpointFiles = fs.readdirSync(csmDir, { withFileTypes: true })
        .filter(d => d.name.endsWith('.json'))
        .map(d => d.name);
      if (checkpointFiles.length > 0) {
        lines.push(`## Checkpoints: ${checkpointFiles.length} in .csm/`);
        const latestCp = checkpointFiles.sort().pop();
        if (latestCp) {
          try {
            const cpData = JSON.parse(safeReadFile(path.join(csmDir, latestCp)) ?? '{}');
            if (cpData.summary) lines.push(`Latest: ${truncate(String(cpData.summary), 200)}`);
            if (cpData.goal) lines.push(`Goal: ${truncate(String(cpData.goal), 160)}`);
            if (Array.isArray(cpData.nextSteps) && cpData.nextSteps.length) {
              lines.push(`Next steps: ${cpData.nextSteps.slice(0, 3).map(String).join('; ')}`);
            }
          } catch { /* ignore parse errors */ }
        }
        lines.push('');
      }
    }
  } catch { /* ignore fs errors */ }

  lines.push('Instruction: Continue from this continuity. Do not re-discover the project cold.');
  lines.push(`Source: sessions + agent_work_journal + chat_messages + memories + .csm/`);

  return {
    section: 'handoff-state',
    status: warnings.some(w => w.includes('failed')) && status !== 'ready' ? 'degraded' : status,
    source: 'sessions + work_journal + chat_messages + memories + .csm/',
    content: lines.join('\n'),
    warnings: warnings.length ? warnings : undefined,
  };
}

// ─── Provider 10: Readiness Summary ───────────────────────────────────────────

async function provideReadiness(
  ctx: OnboardingContext,
  sections: OnboardingSection[],
  totalSections: number,
): Promise<OnboardingSection> {
  const lines: string[] = [];

  const ready = sections.filter(s => s.status === 'ready').length;
  const partial = sections.filter(s => s.status === 'partial').length;
  const degraded = sections.filter(s => s.status === 'degraded').length;
  const missing = sections.filter(s => s.status === 'missing').length;

  lines.push(`You are continuing work in ${ctx.workspacePath || ctx.projectId || 'this workfolder'}.`);
  lines.push(`This is a fresh session body with the prior agent's continuity loaded.`);
  lines.push(`Readiness: ${ready}/${totalSections} sections ready, ${partial} partial, ${degraded} degraded, ${missing} missing.`);

  const handoff = sections.find(s => s.section === 'handoff-state');
  if (handoff) {
    const sessionMatch = handoff.content.match(/- id:\s*(.+)/);
    if (sessionMatch) lines.push(`Prior/latest session: ${sessionMatch[1]}`);
    const filesMatch = handoff.content.match(/Files in play:\s*(.+)/);
    if (filesMatch) lines.push(`Files in play: ${filesMatch[1]}`);
    const decisionBlock = handoff.content.match(/Decisions \/ threads:\n((?:- .+\n?)+)/);
    if (decisionBlock) {
      const first = decisionBlock[1].split('\n').find(l => l.startsWith('- '));
      if (first) lines.push(`Open thread: ${first.replace(/^- /, '')}`);
    }
  }

  const phase = sections.find(s => s.section === 'phase-checkpoint');
  if (phase) {
    const activeMatch = phase.content.match(/Active:\s*(.+)/);
    if (activeMatch) lines.push(`Current phase work: ${activeMatch[1]}`);

    const nextMatch = phase.content.match(/Next:\s*(.+)/);
    if (nextMatch) lines.push(`Next likely step: ${nextMatch[1]}`);
  }

  const advisories = sections.find(s => s.section === 'advisories');
  if (advisories) {
    const lowCap = advisories.content.match(/Low-confidence capabilities:\n([\s\S]*?)(?=\nSource:|$)/);
    if (lowCap) lines.push(`Known risks: low-confidence capabilities detected`);
  }

  const identity = sections.find(s => s.section === 'identity-brief');
  if (identity) {
    const approval = identity.content.match(/Approval required:\s*(.+)/);
    if (approval) lines.push(`Approval required: ${approval[1]}`);
  }

  lines.push('');
  lines.push('You are awake as a continuation of this workfolder\'s active agent. Resume, do not restart.');

  return {
    section: 'readiness-summary',
    status: ready >= 5 ? 'ready' : 'partial',
    source: 'synthesis of all sections',
    content: lines.join('\n'),
  };
}

// ─── Section Extractor ────────────────────────────────────────────────────────

function extractSection(markdown: string, startHeading: string, endHeading?: string): string | null {
  const normalized = markdown.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let capturing = false;
  const result: string[] = [];

  for (const line of lines) {
    if (line.startsWith(startHeading)) {
      capturing = true;
      continue;
    }
    if (capturing && endHeading && line.startsWith(endHeading)) {
      break;
    }
    if (capturing) {
      result.push(line);
    }
  }

  const trimmed = result.join('\n').trim();
  return trimmed || null;
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

const ALL_PROVIDERS: OnboardingProvider[] = [
  provideIdentityBrief,
  provideProjectContinuity,
  providePhaseCheckpoint,
  provideConstraints,
  provideMemories,
  provideBeliefs,
  provideAdvisories,
  provideToolGuidance,
  provideHandoff,
];

export async function buildOnboardingPacket(ctx: OnboardingContext): Promise<OnboardingPacket> {
  const logger = getLogger();
  const sections: OnboardingSection[] = [];

  for (const provider of ALL_PROVIDERS) {
    try {
      const section = await provider(ctx);
      sections.push(section);
    } catch (err) {
      sections.push({
        section: 'unknown',
        status: 'degraded',
        source: 'error',
        content: `Provider failed: ${err instanceof Error ? err.message : String(err)}`,
        warnings: [String(err)],
      });
    }
  }

  const readiness = await provideReadiness(ctx, sections, sections.length + 1);
  sections.push(readiness);

  const allContent = sections.map(s => s.content).join('\n');
  const tokenEstimate = estimateTokens(allContent);

  const packet: OnboardingPacket = {
    projectId: ctx.projectId,
    sessionId: ctx.sessionId,
    workspacePath: ctx.workspacePath,
    sections,
    builtAt: new Date(),
    tokenEstimate,
  };

  const ready = sections.filter(s => s.status === 'ready').length;
  logger.info(`Onboarding packet built: ${ready}/${sections.length} sections ready, ~${tokenEstimate} tokens`);

  return packet;
}

export async function buildOnboardingPacketWithProvenance(
  ctx: OnboardingContext,
): Promise<{ packet: OnboardingPacket; built: BuiltContextInjection }> {
  const packet = await buildOnboardingPacket(ctx);
  const text = formatOnboardingBlock(packet);
  return { packet, built: buildOnboardingProvenance(packet, text) };
}

export function formatOnboardingBlock(packet: OnboardingPacket): string {
  const lines: string[] = [];
  lines.push('═══ AGENT ONBOARDING ═══');
  lines.push('> You are awake. Read this to know your current state.');
  lines.push('');

  for (const section of packet.sections) {
    const statusTag = section.status === 'ready' ? '✓' : section.status === 'partial' ? '~' : section.status === 'degraded' ? '⚠' : '✗';
    lines.push(`── ${section.section} [${statusTag}] ──`);
    lines.push(section.content);
    if (section.warnings?.length) {
      for (const w of section.warnings) {
        lines.push(`  ⚠ ${w}`);
      }
    }
    lines.push('');
  }

  lines.push(`Built: ${packet.builtAt.toISOString()} | Tokens: ~${packet.tokenEstimate}`);
  lines.push('═══════════════════════════');

  return lines.join('\n');
}

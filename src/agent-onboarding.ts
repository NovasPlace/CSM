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
import { getLogger } from './logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SectionStatus = 'ready' | 'partial' | 'missing' | 'degraded';

export interface OnboardingSection {
  section: string;
  status: SectionStatus;
  source: string;
  content: string;
  warnings?: string[];
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

interface MemoryRow { content: string; memory_type: string; importance: number; }
interface BeliefRow { belief_kind: string; subject: string; claim: string; stance: string; confidence: number; uncertainty: number; }
interface PacketCountRow { cnt: string | number; }
interface CandidateRow { candidate_type: string; status: string; cnt: string | number; }
interface CapabilityRow { capability: string; confidence: number; evidence_count: number; }
interface JournalRow { session_id: string; result_summary: string | null; files_touched: unknown; error_summary: string | null; }

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

  lines.push('Role: software-engineering-agent');
  lines.push('Operating mode: cross-session memory persistence active');

  const agentsMd = safeReadFile(path.join(ctx.workspacePath, 'AGENTS.md'));
  if (agentsMd) {
    const behavioralRules = extractSection(agentsMd, 'Behavioral Rules', '## Constraints');
    const approvalBounds = extractSection(agentsMd, 'Approval', '## ');
    if (behavioralRules) lines.push(`Behavioral rules: ${behavioralRules.slice(0, 300)}`);
    if (approvalBounds) lines.push(`Approval boundaries: ${approvalBounds.slice(0, 200)}`);
    lines.push('Source: AGENTS.md');
  } else {
    warnings.push('No AGENTS.md found — behavioral rules not loaded');
    lines.push('Source: defaults (no AGENTS.md)');
  }

  lines.push('Forbidden: destructive DB changes without approval, deleting memories without reason');
  lines.push('Approval required: schema migrations, config changes, git push');

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

  const agentsMd = safeReadFile(path.join(ctx.workspacePath, 'AGENTS.md'));
  if (agentsMd) {
    const constraintsSection = extractSection(agentsMd, '## Constraints', '## Progress');
    if (constraintsSection) {
      const rules = constraintsSection.split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '').trim());
      lines.push(...rules.map(r => `- ${r}`));
      lines.push('Source: AGENTS.md Constraints section');
    } else {
      warnings.push('AGENTS.md has no Constraints section');
    }

    const decisionsSection = extractSection(agentsMd, '## Key Decisions', '## Critical Context');
    if (decisionsSection) {
      const decisions = decisionsSection.split('\n').filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, '').trim());
      if (decisions.length) {
        lines.push('');
        lines.push('Key decisions:');
        lines.push(...decisions.map(d => `- ${d}`));
      }
    }
  }

  if (!lines.length) {
    lines.push('No explicit constraints loaded');
    lines.push('Defaults: PostgreSQL-only, no destructive changes without approval, no silent architecture changes');
    warnings.push('Using default constraints — no AGENTS.md found');
  }

  return {
    section: 'constraints',
    status: agentsMd ? 'ready' : 'partial',
    source: agentsMd ? 'AGENTS.md' : 'defaults',
    content: lines.join('\n'),
    warnings,
  };
}

// ─── Provider 5: Relevant Memories ────────────────────────────────────────────

async function provideMemories(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  try {
    const result = await ctx.pool.query(
      `SELECT id, content, memory_type, importance
       FROM memories
       WHERE project_id = $1
         AND is_active = true
         AND importance >= 0.6
       ORDER BY importance DESC, created_at DESC
       LIMIT 8`,
      [ctx.projectId],
    );

    if (result.rows.length > 0) {
      for (const r of result.rows) {
        const row = r as MemoryRow;
        const content = truncate(String(row.content), 150);
        lines.push(`- [${row.memory_type}] ${content} (importance: ${row.importance})`);
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
       WHERE status = 'active'
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
    const packetResult = await ctx.pool.query(
      `SELECT COUNT(*) as cnt FROM experience_packets
       WHERE project_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
      [ctx.projectId],
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

// ─── Provider 9: Handoff State ────────────────────────────────────────────────

async function provideHandoff(ctx: OnboardingContext): Promise<OnboardingSection> {
  const lines: string[] = [];
  const warnings: string[] = [];

  try {
    const journalResult = await ctx.pool.query(
      `SELECT session_id, result_summary, files_touched, error_summary
       FROM agent_work_journal
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [ctx.projectId],
    );

    if (journalResult.rows.length > 0) {
      const row = journalResult.rows[0] as JournalRow;
      lines.push(`Last session: ${row.session_id}`);
      if (row.result_summary) lines.push(`Work summary: ${truncate(String(row.result_summary), 300)}`);
      if (row.files_touched) {
        const files = typeof row.files_touched === 'string' ? JSON.parse(row.files_touched) : row.files_touched;
        if (Array.isArray(files) && files.length) {
          lines.push(`Files touched: ${files.slice(0, 10).join(', ')}`);
        }
      }
      if (row.error_summary) lines.push(`Known issues: ${truncate(String(row.error_summary), 200)}`);
      lines.push('Source: agent_work_journal');
    } else {
      lines.push('No prior work journal entries for this project');
      lines.push('Source: agent_work_journal (empty)');
    }
  } catch (err) {
    warnings.push(`Journal query failed: ${err instanceof Error ? err.message : String(err)}`);
    lines.push('Status: degraded (journal unavailable)');
  }

  try {
    const csmDir = path.join(ctx.workspacePath, '.csm');
    if (fs.existsSync(csmDir)) {
      const checkpointFiles = fs.readdirSync(csmDir, { withFileTypes: true })
        .filter(d => d.name.endsWith('.json'))
        .map(d => d.name);
      if (checkpointFiles.length > 0) {
        lines.push(`Checkpoints available: ${checkpointFiles.length} (.csm/)`);

        const latestCp = checkpointFiles.sort().pop();
        if (latestCp) {
          try {
            const cpData = JSON.parse(safeReadFile(path.join(csmDir, latestCp)) ?? '{}');
            if (cpData.summary) lines.push(`Latest checkpoint: ${truncate(cpData.summary, 200)}`);
          } catch { /* ignore parse errors */ }
        }
      }
    }
  } catch { /* ignore fs errors */ }

  return {
    section: 'handoff-state',
    status: lines.length > 0 ? 'ready' : 'partial',
    source: lines.length > 0 ? 'agent_work_journal + .csm/' : 'empty',
    content: lines.join('\n'),
    warnings,
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

  lines.push(`You are working in ${ctx.projectId || 'unknown project'}.`);
  lines.push(`Readiness: ${ready}/${totalSections} sections ready, ${partial} partial, ${degraded} degraded, ${missing} missing.`);

  const phase = sections.find(s => s.section === 'phase-checkpoint');
  if (phase) {
    const activeMatch = phase.content.match(/Active:\s*(.+)/);
    if (activeMatch) lines.push(`Current work: ${activeMatch[1]}`);

    const nextMatch = phase.content.match(/Next:\s*(.+)/);
    if (nextMatch) lines.push(`Next likely step: ${nextMatch[1]}`);
  }

  const handoff = sections.find(s => s.section === 'handoff-state');
  if (handoff) {
    const nextStep = handoff.content.match(/Next step:\s*(.+)/);
    if (nextStep) lines.push(`Prior agent left off: ${nextStep[1]}`);
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
  lines.push('You are now ready to begin work.');

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

export function formatOnboardingBlock(packet: OnboardingPacket): string {
  const lines: string[] = [];
  lines.push('═══ AGENT ONBOARDING ═══');
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

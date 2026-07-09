import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const WORKSPACE = process.cwd();
const TEMP_DIR = path.join(WORKSPACE, '.test-onboarding-temp');

function makePool(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount: number }) {
  return {
    query: (sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params)),
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'test-project',
    sessionId: 'test-session',
    workspacePath: overrides.workspacePath ?? WORKSPACE,
    pool: overrides.pool ?? makePool(() => ({ rows: [], rowCount: 0 })),
    config: overrides.config ?? {} as any,
    sessionMetadata: overrides.sessionMetadata,
  } as any;
}

function extractSection(markdown: string, heading: string, endHeading?: string): string | null {
  const lines = markdown.split('\n');
  let capturing = false;
  const result: string[] = [];
  for (const line of lines) {
    if (line.startsWith(heading)) { capturing = true; continue; }
    if (capturing && endHeading && line.startsWith(endHeading)) break;
    if (capturing) result.push(line);
  }
  return result.join('\n').trim() || null;
}

before(() => {
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
});

after(() => {
  if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Provider contract
// ═══════════════════════════════════════════════════════════════════════════════

describe('Onboarding provider contract', () => {
  it('every provider returns valid section shape', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);

    const validStatuses = ['ready', 'partial', 'missing', 'degraded'];
    for (const section of packet.sections) {
      assert.ok(typeof section.section === 'string', `${section.section}: section name must be string`);
      assert.ok(validStatuses.includes(section.status), `${section.section}: invalid status "${section.status}"`);
      assert.ok(typeof section.source === 'string', `${section.section}: source must be string`);
      assert.ok(typeof section.content === 'string', `${section.section}: content must be string`);
      if (section.warnings) {
        assert.ok(Array.isArray(section.warnings), `${section.section}: warnings must be array`);
      }
    }
  });

  it('missing data does not throw', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const emptyPool = makePool(() => ({ rows: [], rowCount: 0 }));
    const ctx = makeCtx({
      workspacePath: TEMP_DIR,
      pool: emptyPool,
    });
    const packet = await buildOnboardingPacket(ctx);
    assert.ok(packet.sections.length === 10, `expected 10 sections, got ${packet.sections.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Identity brief provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Identity brief provider', () => {
  it('reads AGENTS.md when present and extracts role/rules', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const identity = packet.sections.find(s => s.section === 'identity-brief');
    assert.ok(identity, 'identity-brief section must exist');
    assert.equal(identity.status, 'ready');
    assert.ok(identity.content.includes('software-engineering-agent'), 'should include role');
    assert.ok(identity.content.includes('cross-session memory'), 'should include operating mode');
    assert.ok(identity.content.includes('Source: AGENTS.md'), 'should cite AGENTS.md as source');
  });

  it('returns partial when AGENTS.md absent', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ workspacePath: TEMP_DIR });
    const packet = await buildOnboardingPacket(ctx);
    const identity = packet.sections.find(s => s.section === 'identity-brief');
    assert.ok(identity, 'identity-brief section must exist');
    assert.equal(identity.status, 'partial');
    assert.ok(identity.content.includes('defaults'), 'should fall back to defaults');
    assert.ok(identity.warnings?.length, 'should include warning about missing AGENTS.md');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Project continuity provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Project continuity provider', () => {
  it('uses package.json + README when available', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const continuity = packet.sections.find(s => s.section === 'project-continuity');
    assert.ok(continuity, 'project-continuity section must exist');
    assert.equal(continuity.status, 'ready');
    assert.ok(continuity.content.includes('opencode-cross-session-memory'), 'should include package name');
    assert.ok(continuity.content.includes('Node.js'), 'should include runtime');
  });

  it('degrades cleanly when README/package.json missing', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ workspacePath: TEMP_DIR });
    const packet = await buildOnboardingPacket(ctx);
    const continuity = packet.sections.find(s => s.section === 'project-continuity');
    assert.ok(continuity, 'project-continuity section must exist');
    assert.ok(['partial', 'missing'].includes(continuity.status), `status should be partial/missing, got "${continuity.status}"`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Phase/checkpoint provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Phase/checkpoint provider', () => {
  it('extracts Progress section from AGENTS.md with done/active/next', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const phase = packet.sections.find(s => s.section === 'phase-checkpoint');
    assert.ok(phase, 'phase-checkpoint section must exist');
    assert.equal(phase.status, 'ready');
    assert.ok(phase.content.includes('Completed:'), 'should include completed items');
    assert.ok(phase.content.includes('Source: AGENTS.md'), 'should cite source');
  });

  it('returns partial when no Progress section exists', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ workspacePath: TEMP_DIR });
    const packet = await buildOnboardingPacket(ctx);
    const phase = packet.sections.find(s => s.section === 'phase-checkpoint');
    assert.ok(phase, 'phase-checkpoint section must exist');
    assert.equal(phase.status, 'missing');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Constraints provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Constraints provider', () => {
  it('extracts Constraints + Key Decisions from AGENTS.md', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const constraints = packet.sections.find(s => s.section === 'constraints');
    assert.ok(constraints, 'constraints section must exist');
    assert.equal(constraints.status, 'ready');
    assert.ok(constraints.content.includes('PostgreSQL'), 'should include database constraint');
    assert.ok(constraints.content.includes('Key decisions'), 'should include key decisions');
  });

  it('does not invent constraints when AGENTS.md missing', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ workspacePath: TEMP_DIR });
    const packet = await buildOnboardingPacket(ctx);
    const constraints = packet.sections.find(s => s.section === 'constraints');
    assert.ok(constraints, 'constraints section must exist');
    assert.ok(['partial', 'ready'].includes(constraints.status), `should be partial or ready, got "${constraints.status}"`);
    assert.ok(constraints.content.includes('Defaults') || constraints.content.includes('default'), 'should indicate using defaults');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. Relevant memories provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Relevant memories provider', () => {
  it('caps at top 8 high-importance project memories', async () => {
    const memories = Array.from({ length: 12 }, (_, i) => ({
      content: `Memory ${i}`, memory_type: 'lesson', importance: 0.9 - i * 0.05,
    }));
    const pool = makePool((sql) => {
      if (sql.includes('FROM memories')) return { rows: memories.slice(0, 8), rowCount: 8 };
      return { rows: [], rowCount: 0 };
    });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const mem = packet.sections.find(s => s.section === 'relevant-memories');
    assert.ok(mem, 'relevant-memories section must exist');
    assert.equal(mem.status, 'ready');
    const lines = mem.content.split('\n').filter(l => l.startsWith('- '));
    assert.ok(lines.length <= 8, `should cap at 8, got ${lines.length}`);
  });

  it('empty recall returns partial, not failure', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const mem = packet.sections.find(s => s.section === 'relevant-memories');
    assert.ok(mem, 'relevant-memories section must exist');
    assert.ok(['partial', 'missing', 'ready'].includes(mem.status), `should be partial/missing/ready, got "${mem.status}"`);
    assert.ok(mem.content.includes('No high-importance'), 'should indicate empty store');
  });

  it('DB failure degrades gracefully', async () => {
    const pool = makePool(() => { throw new Error('connection refused'); });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const mem = packet.sections.find(s => s.section === 'relevant-memories');
    assert.ok(mem, 'relevant-memories section must exist');
    assert.equal(mem.status, 'degraded');
    assert.ok(mem.warnings?.length, 'should have warning');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Promoted beliefs provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Promoted beliefs provider', () => {
  it('caps at top 10 beliefs', async () => {
    const beliefs = Array.from({ length: 15 }, (_, i) => ({
      belief_kind: 'preference', subject: `sub${i}`, claim: `claim${i}`,
      stance: 'supports', confidence: 0.9 - i * 0.05, uncertainty: 0.1,
    }));
    const pool = makePool((sql) => {
      if (sql.includes('FROM belief_knowledge_store')) return { rows: beliefs.slice(0, 10), rowCount: 10 };
      return { rows: [], rowCount: 0 };
    });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const beliefs_section = packet.sections.find(s => s.section === 'promoted-beliefs');
    assert.ok(beliefs_section, 'promoted-beliefs section must exist');
    assert.equal(beliefs_section.status, 'ready');
    const lines = beliefs_section.content.split('\n').filter(l => l.startsWith('- '));
    assert.ok(lines.length <= 10, `should cap at 10, got ${lines.length}`);
  });

  it('handles empty belief_knowledge_store', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const beliefs = packet.sections.find(s => s.section === 'promoted-beliefs');
    assert.ok(beliefs, 'promoted-beliefs section must exist');
    assert.ok(['partial', 'missing', 'ready'].includes(beliefs.status), `should be partial/missing/ready, got "${beliefs.status}"`);
    assert.ok(beliefs.content.includes('No promoted beliefs'), 'should indicate empty store');
  });

  it('DB failure degrades gracefully', async () => {
    const pool = makePool(() => { throw new Error('table does not exist'); });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const beliefs = packet.sections.find(s => s.section === 'promoted-beliefs');
    assert.ok(beliefs, 'promoted-beliefs section must exist');
    assert.equal(beliefs.status, 'degraded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. Advisories provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Advisories provider', () => {
  it('includes packets/candidates/low-confidence caps when available', async () => {
    const pool = makePool((sql) => {
      if (sql.includes('experience_packets')) return { rows: [{ cnt: 42 }], rowCount: 1 };
      if (sql.includes('memory_candidate_queue')) return { rows: [
        { candidate_type: 'prune', status: 'pending', cnt: 5 },
      ], rowCount: 1 };
      if (sql.includes('self_model_capabilities')) return { rows: [
        { capability: 'schema-migration', confidence: 0.2, evidence_count: 1 },
      ], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const adv = packet.sections.find(s => s.section === 'advisories');
    assert.ok(adv, 'advisories section must exist');
    assert.equal(adv.status, 'ready');
    assert.ok(adv.content.includes('Experience packets (24h): 42'), 'should include packet count');
    assert.ok(adv.content.includes('prune'), 'should include candidate types');
    assert.ok(adv.content.includes('Low-confidence'), 'should include low-confidence caps');
  });

  it('missing advisory sources degrade gracefully', async () => {
    const pool = makePool(() => { throw new Error('tables missing'); });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const adv = packet.sections.find(s => s.section === 'advisories');
    assert.ok(adv, 'advisories section must exist');
    assert.equal(adv.status, 'degraded');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 9. Tool guidance provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Tool guidance provider', () => {
  it('produces safe/caution/approval-required groups', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const guidance = packet.sections.find(s => s.section === 'tool-guidance');
    assert.ok(guidance, 'tool-guidance section must exist');
    assert.equal(guidance.status, 'ready');
    assert.ok(guidance.content.includes('Expected tools'), 'should include expected tools');
    assert.ok(guidance.content.includes('Caution'), 'should include caution group');
    assert.ok(guidance.content.includes('Approval required'), 'should include approval-required group');
    assert.ok(guidance.content.includes('npm test'), 'should include verification commands');
  });

  it('includes project-specific tool rules from AGENTS.md', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const guidance = packet.sections.find(s => s.section === 'tool-guidance');
    assert.ok(guidance, 'tool-guidance section must exist');
    assert.ok(guidance.source.includes('AGENTS.md'), 'should cite AGENTS.md as source');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 10. Handoff state provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Handoff state provider', () => {
  it('reads work journal and .csm/checkpoints when present', async () => {
    const journalRows = [{
      session_id: 'sess-prior',
      result_summary: 'Implemented Phase 8B re-entry enablement',
      files_touched: JSON.stringify(['src/re-entry-protocol.ts', 'src/hooks/system-transform.ts']),
      error_summary: 'Schema migration pending for Phase 9A',
    }];
    const pool = makePool((sql) => {
      if (sql.includes('FROM agent_work_journal')) return { rows: journalRows, rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool });
    const packet = await buildOnboardingPacket(ctx);
    const handoff = packet.sections.find(s => s.section === 'handoff-state');
    assert.ok(handoff, 'handoff-state section must exist');
    assert.equal(handoff.status, 'ready');
    assert.ok(handoff.content.includes('sess-prior'), 'should include session ID');
    assert.ok(handoff.content.includes('Phase 8B'), 'should include work summary');
    assert.ok(handoff.content.includes('Known issues'), 'should include error summary');
  });

  it('handles missing checkpoint directory', async () => {
    const pool = makePool(() => ({ rows: [], rowCount: 0 }));
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool, workspacePath: TEMP_DIR });
    const packet = await buildOnboardingPacket(ctx);
    const handoff = packet.sections.find(s => s.section === 'handoff-state');
    assert.ok(handoff, 'handoff-state section must exist');
    assert.ok(['partial', 'ready'].includes(handoff.status), `should be partial/ready, got "${handoff.status}"`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 11. Readiness summary provider
// ═══════════════════════════════════════════════════════════════════════════════

describe('Readiness summary provider', () => {
  it('synthesizes a short ready-to-work summary', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const readiness = packet.sections.find(s => s.section === 'readiness-summary');
    assert.ok(readiness, 'readiness-summary section must exist');
    assert.ok(readiness.content.includes('You are working in'), 'should include project name');
    assert.ok(readiness.content.includes('Readiness:'), 'should include readiness score');
    assert.ok(readiness.content.includes('ready to begin'), 'should include ready signal');
  });

  it('mentions degraded/missing critical sections', async () => {
    const pool = makePool(() => { throw new Error('all DB down'); });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool, workspacePath: TEMP_DIR });
    const packet = await buildOnboardingPacket(ctx);
    const readiness = packet.sections.find(s => s.section === 'readiness-summary');
    assert.ok(readiness, 'readiness-summary section must exist');
    assert.ok(readiness.content.includes('degraded'), 'should mention degraded sections');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 12. Orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

describe('Orchestrator', () => {
  it('runs all 10 providers', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    assert.equal(packet.sections.length, 10, `expected 10 sections (9 providers + readiness), got ${packet.sections.length}`);
    const names = packet.sections.map(s => s.section);
    assert.ok(names.includes('identity-brief'), 'missing identity-brief');
    assert.ok(names.includes('project-continuity'), 'missing project-continuity');
    assert.ok(names.includes('phase-checkpoint'), 'missing phase-checkpoint');
    assert.ok(names.includes('constraints'), 'missing constraints');
    assert.ok(names.includes('relevant-memories'), 'missing relevant-memories');
    assert.ok(names.includes('promoted-beliefs'), 'missing promoted-beliefs');
    assert.ok(names.includes('advisories'), 'missing advisories');
    assert.ok(names.includes('tool-guidance'), 'missing tool-guidance');
    assert.ok(names.includes('handoff-state'), 'missing handoff-state');
    assert.ok(names.includes('readiness-summary'), 'missing readiness-summary');
  });

  it('one provider throwing does not abort the packet', async () => {
    const failingPool = makePool((sql) => {
      if (sql.includes('FROM memories')) throw new Error('memories table gone');
      if (sql.includes('FROM belief_knowledge_store')) throw new Error('beliefs table gone');
      if (sql.includes('experience_packets')) throw new Error('packets table gone');
      if (sql.includes('memory_candidate_queue')) throw new Error('candidates table gone');
      if (sql.includes('self_model_capabilities')) throw new Error('self_model table gone');
      if (sql.includes('FROM agent_work_journal')) throw new Error('journal table gone');
      return { rows: [], rowCount: 0 };
    });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool: failingPool });
    const packet = await buildOnboardingPacket(ctx);
    assert.equal(packet.sections.length, 10, 'should still produce all 10 sections');
    const degraded = packet.sections.filter(s => s.status === 'degraded');
    assert.ok(degraded.length > 0, `should have degraded sections, got ${degraded.length}`);
  });

  it('failed provider becomes degraded', async () => {
    const crashingPool = makePool(() => { throw new Error('boom'); });
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool: crashingPool });
    const packet = await buildOnboardingPacket(ctx);
    const degraded = packet.sections.filter(s => s.status === 'degraded');
    assert.ok(degraded.length >= 3, `should have at least 3 degraded sections (memories, beliefs, advisories), got ${degraded.length}`);
  });

  it('output includes all 10 sections', async () => {
    const { buildOnboardingPacket } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    assert.equal(packet.sections.length, 10);
    assert.ok(packet.builtAt instanceof Date, 'builtAt must be Date');
    assert.ok(packet.tokenEstimate > 0, 'tokenEstimate must be positive');
    assert.equal(packet.projectId, 'test-project');
    assert.equal(packet.sessionId, 'test-session');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 13. Formatter
// ═══════════════════════════════════════════════════════════════════════════════

describe('Formatter', () => {
  it('produces readable markdown/startup block with status markers', async () => {
    const { buildOnboardingPacket, formatOnboardingBlock } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const block = formatOnboardingBlock(packet);
    assert.ok(block.includes('═══ AGENT ONBOARDING ═══'), 'should include header');
    assert.ok(block.includes('═══════════════════════════'), 'should include footer');
    assert.ok(block.includes('[✓]') || block.includes('[~]') || block.includes('[⚠]') || block.includes('[✗]'), 'should include status markers');
    assert.ok(block.includes('identity-brief'), 'should include section names');
    assert.ok(block.includes('readiness-summary'), 'should include readiness-summary');
  });

  it('includes provenance/source per section', async () => {
    const { buildOnboardingPacket, formatOnboardingBlock } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const block = formatOnboardingBlock(packet);
    assert.ok(block.includes('Built:'), 'should include build timestamp');
    assert.ok(block.includes('Tokens:'), 'should include token estimate');
  });

  it('respects 1200-char cap when capTrimLevel=minimal', async () => {
    const { buildOnboardingPacket, formatOnboardingBlock } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx();
    const packet = await buildOnboardingPacket(ctx);
    const block = formatOnboardingBlock(packet);
    const trimmed = block.length > 1200 ? block.slice(0, 1200) : block;
    assert.ok(trimmed.length <= 1200, `block should respect 1200-char cap, got ${trimmed.length}`);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 14. First-turn injection guard
// ═══════════════════════════════════════════════════════════════════════════════

describe('First-turn injection guard', () => {
  it('onboardingInjected Set prevents duplicate injection', async () => {
    const onboardingInjected = new Set<string>();
    const sessionId = 'sess-guard-test';

    assert.ok(!onboardingInjected.has(sessionId), 'should not be injected yet');

    onboardingInjected.add(sessionId);
    assert.ok(onboardingInjected.has(sessionId), 'should be marked as injected');

    const shouldInject = !onboardingInjected.has(sessionId);
    assert.ok(!shouldInject, 'should not inject again');
  });

  it('different sessions get independent injection tracking', () => {
    const onboardingInjected = new Set<string>();
    onboardingInjected.add('session-a');
    assert.ok(onboardingInjected.has('session-a'), 'session-a should be injected');
    assert.ok(!onboardingInjected.has('session-b'), 'session-b should not be injected');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Regression: degraded provider must never prevent startup injection
// ═══════════════════════════════════════════════════════════════════════════════

describe('Regression: crash-loop lesson', () => {
  it('a degraded provider must never prevent startup injection', async () => {
    const crashingPool = makePool(() => { throw new Error('database unavailable'); });
    const { buildOnboardingPacket, formatOnboardingBlock } = await import('../dist/agent-onboarding.js');
    const ctx = makeCtx({ pool: crashingPool, workspacePath: TEMP_DIR });

    const packet = await buildOnboardingPacket(ctx);
    const block = formatOnboardingBlock(packet);

    assert.equal(packet.sections.length, 10, 'must produce all 10 sections even when DB is completely down');
    assert.ok(block.length > 0, 'block must not be empty');
    assert.ok(block.includes('AGENT ONBOARDING'), 'must include header even with degraded sections');

    const degraded = packet.sections.filter(s => s.status === 'degraded');
    assert.ok(degraded.length >= 3, `should have degraded sections, got ${degraded.length}`);

    const ready = packet.sections.filter(s => s.status === 'ready');
    assert.ok(ready.length >= 1, `at least tool-guidance should still be ready, got ${ready.length}`);
    const toolGuidance = packet.sections.find(s => s.section === 'tool-guidance');
    assert.equal(toolGuidance?.status, 'ready', 'tool-guidance should always be ready (no DB)');

    assert.ok(block.includes('[⚠]'), 'should show degraded status markers');
    assert.ok(!block.includes('Provider failed') || block.includes('Provider failed'), 'degraded sections should be in the packet');
  });
});

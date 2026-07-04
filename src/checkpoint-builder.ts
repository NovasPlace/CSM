// Phase 4A — deterministic checkpoint builder
// No LLM. Pure heuristic extraction from session messages.
// Produces CreateCheckpointInput + raw captures for the store.
import { estimateTokens } from './token-bucket-analyzer.js';
import {
  SessionMessage, SourceRef, CompactedRef,
  CreateCheckpointInput, CheckpointConfig,
} from './checkpoint-types.js';
import { buildCheckpointMarkdown, CheckpointSections } from './checkpoint-markdown.js';
import { collectRawCaptures, estimateInputTokens } from './checkpoint-capture.js';

/** Builder input. */
export interface BuildInput {
  sessionId: string;
  projectId: string | null;
  messages: SessionMessage[];
  config: CheckpointConfig;
}

/** Builder output — feeds directly into CheckpointStore.createCheckpoint. */
export interface BuildResult {
  checkpoint: CreateCheckpointInput;
  inputTokensEstimate: number;
  buildMs: number;
}

const FILE_PATH_RE = /(?:[\w./-]+\/[\w./-]+\.[a-z]{2,4})|(?:[A-Za-z]:[\\w\\-]+\\[\w.\\-]+)/g;
const MAX_GOAL_CHARS = 200;

/** Main entry: deterministic checkpoint assembly. */
export function buildCheckpoint(input: BuildInput): BuildResult {
  const t0 = Date.now();
  const msgs = input.messages;
  const goal = extractGoal(msgs);
  const constraints = extractKeywordLines(msgs, ['must', "don't", 'never', 'rule', 'forbidden', 'required']);
  const currentState = extractKeywordLines(msgs, ['COMPLETE', 'DONE', 'stable', 'frozen', 'phase', 'approved', 'READY'], true);
  const completedWork = extractKeywordLines(msgs, ['completed', 'fixed', 'passed', 'done', 'implemented', 'verified']);
  const decisions = extractKeywordLines(msgs, ['decided', 'approved', 'will use', 'chose', 'locked', 'adopted']);
  const files = extractFiles(msgs);
  const tests = extractTests(msgs);
  const risks = extractRisks(msgs);
  const nextSteps = extractNextSteps(msgs);
  const compactedRefs = extractCompactedRefs(msgs);
  const refs = extractSourceRefs(msgs);
  const rawCaptures = collectRawCaptures(msgs, input.config);
  const sections: CheckpointSections = {
    goal, constraints, currentState, completedWork, decisions,
    files, tests, risks, nextSteps, refs, compactedRefs,
  };
  const markdown = buildCheckpointMarkdown(sections);
  const summaryTokens = estimateTokens(markdown);
  const inputTokensEstimate = estimateInputTokens(msgs);
  const firstId = msgs[0]?.info?.id;
  const lastId = msgs[msgs.length - 1]?.info?.id;
  const checkpoint: CreateCheckpointInput = {
    sessionId: input.sessionId,
    projectId: input.projectId ?? undefined,
    sourceMessageStart: firstId,
    sourceMessageEnd: lastId,
    summaryMarkdown: markdown,
    summaryTokens,
    inputTokensEstimate,
    sourceRefs: refs,
    compactedRefs,
    filesMentioned: files.map(f => f.path),
    testsMentioned: tests,
    risks,
    nextSteps,
    rawCaptures,
  };
  return { checkpoint, inputTokensEstimate, buildMs: Date.now() - t0 };
}

function extractGoal(msgs: SessionMessage[]): string {
  for (const m of msgs) {
    if (m.info?.role !== 'user') continue;
    const text = textOf(m);
    if (text.trim().length > 0) return text.slice(0, MAX_GOAL_CHARS).replace(/\s+/g, ' ').trim();
  }
  return '';
}

/** Extract lines/sentences containing any keyword. matchCase for state markers. */
function extractKeywordLines(msgs: SessionMessage[], keywords: string[], matchCase = false): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of msgs) {
    const text = textOf(m);
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length < 5 || trimmed.length > 300) continue;
      const hay = matchCase ? trimmed : trimmed.toLowerCase();
      const hit = keywords.some(k => hay.includes(matchCase ? k : k.toLowerCase()));
      if (hit && !seen.has(trimmed)) { seen.add(trimmed); out.push(trimmed); }
    }
  }
  return out.slice(0, 15);
}

function extractFiles(msgs: SessionMessage[]): Array<{ path: string; note: string }> {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    const text = textOf(m);
    const matches = text.match(FILE_PATH_RE) ?? [];
    for (const f of matches) counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, note: `mentioned ${count}x` }));
}

function extractTests(msgs: SessionMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?:npm test|npx tsc|PASS|FAIL|\d+\/\d+ (?:pass|fail)|tests? (?:pass|fail)|verified|build (?:clean|succeed))/i;
  for (const m of msgs) {
    if (m.info?.role !== 'assistant') continue;
    for (const line of textOf(m).split('\n')) {
      const t = line.trim();
      if (t.length < 5 || t.length > 200) continue;
      if (re.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out.slice(0, 15);
}

function extractRisks(msgs: SessionMessage[]): string[] {
  return extractKeywordLines(msgs,
    ['risk', 'untested', 'mayday', 'TODO', 'FIXME', 'not verified', 'unknown', 'unresolved', 'blocker'],
    true).slice(0, 10);
}

function extractNextSteps(msgs: SessionMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /^(?:next|then|should|todo|step|1\.|2\.)\b/i;
  // Scan the last few assistant messages for forward-looking statements
  const recent = msgs.filter(m => m.info?.role === 'assistant').slice(-3);
  for (const m of recent) {
    for (const line of textOf(m).split('\n')) {
      const t = line.trim();
      if (t.length < 5 || t.length > 200) continue;
      if (re.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
    }
  }
  return out.slice(0, 8);
}

function extractCompactedRefs(msgs: SessionMessage[]): CompactedRef[] {
  const refs: CompactedRef[] = [];
  const re = /\[COMPACTED[^\]]*\]/g;
  for (const m of msgs) {
    const text = textOf(m);
    const matches = text.match(re) ?? [];
    for (const marker of matches) {
      refs.push({
        marker,
        approxOriginalTokens: 0,
        messageId: m.info?.id,
        expandHint: 'v1-compacted region; expand if detail needed',
      });
    }
  }
  return refs.slice(0, 30);
}

function extractSourceRefs(msgs: SessionMessage[]): SourceRef[] {
  const refs: SourceRef[] = [];
  for (const m of msgs) {
    const role = (m.info?.role ?? 'unknown') as SourceRef['role'];
    for (const p of m.parts ?? []) {
      if (p.type === 'tool' && p.toolCallId) {
        refs.push({ messageId: m.info?.id, toolCallId: p.toolCallId, role, kind: 'tool_output', note: 'tool result' });
      }
    }
  }
  return refs.slice(0, 50);
}

function textOf(m: SessionMessage): string {
  return (m.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
}

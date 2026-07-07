/**
 * Phase 5A — Free-text decision classifier.
 *
 * Lexical pattern set → `decision_kind` + base confidence, applied to user-role
 * free text only. Constraint 1: only explicit commitments with confidence and
 * decision_kind fire. Quote/code/table pasted text is filtered before pattern
 * matching. Negation/constraint patterns are included; recency wins when both
 * positive and negative match.
 *
 * Output is used by event-hooks.ts to create `decision` experience packets.
 * Returns null when no pattern matches or confidence < 0.6 floor.
 */

export type DecisionKind =
  | 'commit'
  | 'approve'
  | 'reject'
  | 'choose'
  | 'abandon'
  | 'defer'
  | 'constrain';

export interface Classification {
  decisionKind: DecisionKind;
  confidence: number;
  intent: string;
  pattern: string;
}

interface PatternEntry {
  regex: RegExp;
  kind: DecisionKind;
  baseConfidence: number;
}

const POSITIVE_PATTERNS: PatternEntry[] = [
  { regex: /\bi(?:'ve| have)?\s+decided\s+(?:to|on|that)\b/i, kind: 'commit', baseConfidence: 0.9 },
  { regex: /^decision:\s+/i, kind: 'commit', baseConfidence: 0.9 },
  { regex: /\bgoing\s+with\b.*\(recommended\)/i, kind: 'commit', baseConfidence: 0.9 },
  { regex: /\bapproved?\b/i, kind: 'approve', baseConfidence: 0.85 },
  { regex: /\baccept(?:ed)?\b/i, kind: 'approve', baseConfidence: 0.85 },
  { regex: /\bconfirmed?\b/i, kind: 'approve', baseConfidence: 0.85 },
  { regex: /\blet'?s\s+go\s+with\b/i, kind: 'approve', baseConfidence: 0.85 },
  { regex: /\bchoosing\b/i, kind: 'choose', baseConfidence: 0.8 },
  { regex: /\bchose\b/i, kind: 'choose', baseConfidence: 0.8 },
  { regex: /\bpicking\b/i, kind: 'choose', baseConfidence: 0.8 },
  { regex: /\babandone?[d]?\b/i, kind: 'abandon', baseConfidence: 0.85 },
  { regex: /\bcancel(?:ing|ed)?\b/i, kind: 'abandon', baseConfidence: 0.85 },
  { regex: /\bdropping\b/i, kind: 'abandon', baseConfidence: 0.85 },
  { regex: /\bdefer(?:red|ring)?\b/i, kind: 'defer', baseConfidence: 0.7 },
  { regex: /\bpark\s+it\b/i, kind: 'defer', baseConfidence: 0.7 },
  { regex: /\bcome\s+back\s+to\s+(?:this\s+)?later\b/i, kind: 'defer', baseConfidence: 0.7 },
  { regex: /^i'?ll\s+\w+/i, kind: 'commit', baseConfidence: 0.6 },
  { regex: /^i\s+will\s+\w+/i, kind: 'commit', baseConfidence: 0.6 },
  { regex: /^i'?m\s+going\s+to\s+\w+/i, kind: 'commit', baseConfidence: 0.6 },
  { regex: /^let'?s\s+\w+/i, kind: 'commit', baseConfidence: 0.6 },
];

// Negation/constraint patterns — must be followed by a verb/object word.
const NEGATION_PATTERNS: PatternEntry[] = [
  { regex: /\bi\s+won't\s+\w+/i, kind: 'reject', baseConfidence: 0.85 },
  { regex: /\bi\s+will\s+not\s+\w+/i, kind: 'reject', baseConfidence: 0.85 },
  { regex: /\bwe('?re|\s+are)\s+not\s+going\s+to\s+\w+/i, kind: 'reject', baseConfidence: 0.85 },
  { regex: /\bnot\s+going\s+to\s+\w+/i, kind: 'reject', baseConfidence: 0.85 },
  { regex: /\bdon't\s+\w+/i, kind: 'reject', baseConfidence: 0.8 },
  { regex: /\bdo\s+not\s+\w+/i, kind: 'reject', baseConfidence: 0.8 },
  { regex: /\bnever\s+\w+/i, kind: 'reject', baseConfidence: 0.8 },
  { regex: /\bno,?\s+do\s+not\b/i, kind: 'reject', baseConfidence: 0.85 },
  { regex: /\bavoid\s+\w+/i, kind: 'constrain', baseConfidence: 0.75 },
  { regex: /\bskip\s+\w+/i, kind: 'constrain', baseConfidence: 0.75 },
  { regex: /\bwithout\s+\w+/i, kind: 'constrain', baseConfidence: 0.75 },
];

const EMISSION_FLOOR = 0.6;
const MAX_INTENT_CHARS = 200;

/**
 * Strip markdown noise (blockquote, code fence, table, inline code) before
 * matching. Applied line-by-line, then joined.
 */
function stripMarkdownNoise(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;
  for (const raw of lines) {
    const trimmed = raw.trimStart();
    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (trimmed.startsWith('>')) continue;       // blockquote
    if (trimmed.startsWith('|')) continue;         // table row
    out.push(raw);
  }
  // Strip inline code spans (so `let's pattern` doesn't false-match).
  return out.join('\n').replace(/`[^`]*`/g, '');
}

function lastMatch(text: string, patterns: PatternEntry[]): { entry: PatternEntry; index: number } | null {
  let best: { entry: PatternEntry; index: number } | null = null;
  for (const entry of patterns) {
    const m = entry.regex.exec(text);
    if (m && (best === null || m.index > best.index)) {
      best = { entry, index: m.index };
    }
  }
  return best;
}

export function classifyFreeTextDecision(text: string): Classification | null {
  const cleaned = stripMarkdownNoise(text);
  if (!cleaned.trim()) return null;

  // Find most-recent positive and negation matches — recency wins.
  const pos = lastMatch(cleaned, POSITIVE_PATTERNS);
  const neg = lastMatch(cleaned, NEGATION_PATTERNS);

  let chosen: { entry: PatternEntry; index: number } | null;
  if (pos && neg) {
    chosen = pos.index >= neg.index ? pos : neg;
  } else {
    chosen = pos ?? neg;
  }
  if (!chosen) return null;

  const { entry, index } = chosen;

  // Intent = matched clause, truncated.
  const tail = cleaned.slice(index, index + MAX_INTENT_CHARS).split(/\r?\n/)[0] || '';
  let intent = tail.trim();
  if (intent.length > MAX_INTENT_CHARS) intent = intent.slice(0, MAX_INTENT_CHARS);

  // Modifier: justification boost / hedge penalty.
  let confidence = entry.baseConfidence;
  if (/\b(because|since|reason|理由)\b/i.test(cleaned)) confidence += 0.05;
  if (/\b(maybe|might|could)\b/i.test(cleaned)) confidence -= 0.2;
  if (confidence < EMISSION_FLOOR) return null;
  if (confidence > 1) confidence = 1;

  return {
    decisionKind: entry.kind,
    confidence,
    intent,
    pattern: entry.regex.source,
  };
}
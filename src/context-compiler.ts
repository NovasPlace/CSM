/**
 * Phase 5: Context Compiler — Input Token Governor
 *
 * Keeps input under a configurable budget by compressing low-value context
 * while preserving high-signal information (errors, active files, constraints).
 *
 * Architecture: raw messages → classify importance → preserve pinned → compress → send
 * Transparency: every compression produces a CompressedPartDetail with risk + preserved signals
 */
import { estimateTokens } from './token-bucket-analyzer.js';
import type { ContextCompilerConfig, BudgetMode, CompressedPartDetail, AlchemistLesson, LessonTelemetry } from './types.js';

interface SdkPart {
  type?: string;
  text?: string;
  tool?: string;
  synthetic?: boolean;
  id?: string;
  sessionID?: string;
  messageID?: string;
  state?: {
    status?: string;
    type?: string;
    output?: string;
    exitCode?: number | string;
    input?: {
      command?: string;
      filePath?: string;
      pattern?: string;
      exitCode?: number;
    };
  };
  metadata?: Record<string, unknown>;
}

interface SdkMessage {
  info?: Record<string, unknown> & {
    role?: string;
    sessionID?: string;
    id?: string;
    time?: Record<string, unknown>;
  };
  parts?: SdkPart[];
}

function buildSyntheticLessonMessage(
  messages: SdkMessage[],
  lessonBlock: string,
): SdkMessage {
  const template = [...messages].reverse().find((message) => message.info?.role === 'assistant');
  const sessionID = String(template?.info?.sessionID ?? 'lesson-session');
  const messageID = `${sessionID}-lesson-${Date.now()}`;
  const partTemplate = template?.parts?.find((part) => part?.type === 'text');
  const lessonPart = partTemplate?.type === 'text'
    ? {
      type: 'text',
      id: `${messageID}-part`,
      sessionID,
      messageID,
      text: lessonBlock,
      synthetic: true,
      metadata: { injectedLesson: true },
    }
    : {
      id: `${messageID}-part`,
      sessionID,
      messageID,
      type: 'text',
      text: lessonBlock,
      synthetic: true,
      metadata: { injectedLesson: true },
    };

  return {
    info: template?.info
      ? {
        ...template.info,
        id: messageID,
        role: 'assistant',
        sessionID,
        time: { ...(template.info.time as Record<string, unknown> ?? {}), created: Date.now() },
      }
      : {
        id: messageID,
        sessionID,
        role: 'assistant',
        time: { created: Date.now() },
        parentID: '',
        modelID: 'synthetic',
        providerID: 'synthetic',
        mode: 'default',
        agent: 'cross-session-memory',
        path: { cwd: '', root: '' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    parts: [lessonPart],
  };
}

function buildLessonPart(
  message: SdkMessage,
  lessonBlock: string,
): SdkPart {
  const messageID = String(message.info?.id ?? `${message.info?.sessionID ?? 'lesson-session'}-lesson-${Date.now()}`);
  const sessionID = String(message.info?.sessionID ?? 'lesson-session');
  const template = message.parts?.find((part) => part?.type === 'text');
  if (template?.type === 'text') {
    return {
      type: 'text',
      id: `${messageID}-lesson-part`,
      sessionID,
      messageID,
      text: lessonBlock,
      synthetic: true,
      metadata: { injectedLesson: true },
    };
  }
  return {
    id: `${messageID}-lesson-part`,
    sessionID,
    messageID,
    type: 'text',
    text: lessonBlock,
    synthetic: true,
    metadata: { injectedLesson: true },
  };
}

export interface CompileResult {
  beforeTokens: number;
  afterTokens: number;
  budget: number;
  partsCompressed: number;
  partsPinned: number;
  mode: BudgetMode;
  compressedDetails: CompressedPartDetail[];
  pinnedCategories: Record<string, number>;
  lessonTelemetry?: LessonTelemetry;
  injectedLessons?: AlchemistLesson[];
}

const LESSON_TYPE_PRIORITY: Record<string, number> = {
  risk_rule: 6,
  anti_pattern: 5,
  repair_recipe: 4,
  validation_checklist: 3,
  verified_pattern: 2,
  procedure: 1,
};

function extractTaskConcepts(messages: SdkMessage[]): string {
  const concepts: string[] = [];
  for (const msg of messages) {
    const role = msg.info?.role ?? '';
    if (role !== 'user' && role !== 'assistant') continue;
    for (const part of msg.parts ?? []) {
      const text = String(part.text ?? '');
      if (text.length > 10) concepts.push(text.slice(0, 200));
      const tool = String(part.tool ?? '');
      if (tool) concepts.push(tool);
      const cmd = String(part.state?.input?.command ?? '');
      if (cmd) concepts.push(cmd.slice(0, 100));
      const fp = String(part.state?.input?.filePath ?? part.state?.input?.pattern ?? '');
      if (fp) concepts.push(fp);
    }
  }
  return concepts.join(' ').slice(0, 2000);
}

interface LessonRecallResult {
  lessons: AlchemistLesson[];
  injected: AlchemistLesson[];
  tokensUsed: number;
}

function rankLessons(lessons: AlchemistLesson[], tokenBudget: number): LessonRecallResult {
  const CONFIDENCE_THRESHOLD = 0.5;
  const ranked = lessons
    .filter(l => (l.confidence ?? 1) >= CONFIDENCE_THRESHOLD)
    .map(l => ({
      lesson: l,
      priority: (LESSON_TYPE_PRIORITY[l.type] ?? 0) * 10 + (l.verified ? 5 : 0) + Math.min((l.confidence ?? 0.5) * 4, 4),
    }))
    .sort((a, b) => b.priority - a.priority);

  const injected: AlchemistLesson[] = [];
  let tokensUsed = 0;
  for (const { lesson } of ranked) {
    if (injected.length >= 10) break;
    const est = estimateTokens(`- [${lesson.type}] ${lesson.action}`);
    if (tokensUsed + est > tokenBudget) break;
    injected.push(lesson);
    tokensUsed += est;
  }
  return { lessons: ranked.map(r => r.lesson), injected, tokensUsed };
}

export function formatLessonBlock(injected: AlchemistLesson[]): string {
  if (injected.length === 0) return '';
  const lines = injected.map(l => `- [${l.type}] ${l.action}`);
  return `## Relevant Verified Lessons\n${lines.join('\n')}`;
}

export function compileContextWithLessons(
   messages: SdkMessage[],
   config: ContextCompilerConfig,
   alchemist?: { recall: (context: string) => AlchemistLesson[] },
   lessonTokenBudget: number = 500,
 ): CompileResult {
  const telemetry: LessonTelemetry = { hits: 0, misses: 0, tokensUsed: 0, lessonsQueried: 0 };
  let injectedLessons: AlchemistLesson[] = [];

  if (alchemist) {
    try {
      const concepts = extractTaskConcepts(messages);
      if (concepts.length > 10) {
        const allRecalled = alchemist.recall(concepts);
        telemetry.lessonsQueried = allRecalled.length;
        if (allRecalled.length > 0) {
          const { lessons, injected, tokensUsed } = rankLessons(allRecalled, lessonTokenBudget);
          telemetry.hits = injected.length;
          telemetry.misses = lessons.length - injected.length;
          telemetry.tokensUsed = tokensUsed;
          injectedLessons = injected;
          if (injected.length > 0) {
            const lessonBlock = formatLessonBlock(injected);
            const lastAssistant = [...messages].reverse().find(m => m.info?.role === 'assistant');
            if (lastAssistant) {
              lastAssistant.parts = [...(lastAssistant.parts ?? []), buildLessonPart(lastAssistant, lessonBlock)];
            } else {
              messages.push(buildSyntheticLessonMessage(messages, lessonBlock));
            }
          }
        }
      }
    } catch {
      telemetry.misses = -1;
    }
  }

  const result = compileContext(messages, config);
  result.lessonTelemetry = telemetry;
  result.injectedLessons = injectedLessons;
  return result;
}

const ALREADY_COMPACTED = ['[COMPACTED_TOOL]', '[COMPRESSED]', '[TOOL:', '[CRITICAL_TOOL:', '[OK]'];
const STEP_TYPES = ['step-start', 'step-finish', 'compaction', 'reasoning', 'snapshot', 'patch'];

const CRITICAL_PATTERNS: RegExp[] = [
  /\berror\b/i, /\bexception\b/i, /\bfail(ed|ure)?\b/i,
  /\bstack\s*trace\b/i, /\bTraceback\b/i,
  /\bexit\s+code\s*[1-9]/, /\bFATAL\b/i,
  /\bmigration\b.*\b(fail|error|rollback)\b/i,
  /\bCONFLICT\b/i, /\bMERGE\s+CONFLICT\b/i,
  /\bdenied\b/i, /\bpermission\s+denied\b/i,
  /\bECONNREFUSED\b/i, /\bETIMEDOUT\b/i, /\bENOTFOUND\b/i,
];
const LOW_SIGNAL_PATTERNS: RegExp[] = [
  /^\s*\d+\s+(file|files|items?|results?)\s*(found|matched|listed)/im,
  /^\.\/[^\n]+$/m,
  /^\s*$/m,
];
const LOW_SIGNAL_TOOLS = new Set(['glob', 'ls', 'directory']);
const CRITICAL_TOOLS = new Set(['edit', 'write', 'bash']);

/** Score tool output criticality: 0=low, 1=medium, 2=critical */
export function scoreCriticality(part: SdkPart): number {
  if (part.type !== 'tool') return 0;
  if (part.state?.status === 'error' || part.state?.type === 'error') return 2;
  const tool = String(part.tool ?? '');
  const output = String(part.state?.output ?? '');
  for (const pat of CRITICAL_PATTERNS) {
    if (pat.test(output)) return 2;
  }
  if (CRITICAL_TOOLS.has(tool)) {
    const exitCode = part.state?.exitCode ?? part.state?.input?.exitCode;
    if (exitCode != null && exitCode !== 0 && exitCode !== '0') return 2;
    if (tool === 'bash' && /\bdiff\b|\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout)\b/i.test(String(part.state?.input?.command ?? ''))) return 1;
    if (tool === 'edit' || tool === 'write') return 1;
  }
  if (LOW_SIGNAL_TOOLS.has(tool)) return 0;
  if (output.trim().length < 50) return 0;
  for (const pat of LOW_SIGNAL_PATTERNS) {
    if (pat.test(output)) return 0;
  }
  return 0;
}

function isAlreadyCompressed(part: SdkPart): boolean {
  const text = part.text ?? part.state?.output ?? '';
  return ALREADY_COMPACTED.some(m => String(text).startsWith(m));
}

/** Compute pressure-aware recent window size */
function adaptiveRecentWindow(
  baseWindow: number, totalTokens: number, budget: number,
): number {
  if (budget <= 0) return 1;
  const pressure = totalTokens / budget;
  if (pressure <= 1.0) return baseWindow;
  if (pressure <= 2.0) return Math.max(2, Math.floor(baseWindow * 0.5));
  if (pressure <= 3.0) return Math.max(1, Math.floor(baseWindow * 0.3));
  return 1;
}

/** Returns pinned category string or 'compressible' */
function classifyPart(
  part: SdkPart, msgIndex: number, totalMsgs: number, role: string,
  adaptiveWindow: number, pressureRatio: number,
): string {
  if (isAlreadyCompressed(part)) return 'compressible';
  if (role === 'user') return 'user_message';
  const criticality = scoreCriticality(part);
  const isRecent = msgIndex >= totalMsgs - adaptiveWindow;
  const isLastTurn = msgIndex >= totalMsgs - 2;
  if (isLastTurn) {
    if (criticality >= 2 && pressureRatio > 2.0) return 'compressible_critical';
    if (criticality >= 2) return 'critical_raw';
    if (pressureRatio > 1.5) return 'compressible';
    return 'recent_turn';
  }
  if (isRecent) {
    if (criticality >= 2 && pressureRatio > 3.0) return 'compressible_critical';
    if (criticality >= 2) return 'critical_raw';
    if (criticality >= 1 && pressureRatio > 1.5) return 'compressible_critical';
    if (criticality >= 1) return 'recent_critical';
    if (pressureRatio > 1.5) return 'compressible';
    return 'recent_turn';
  }
  if (criticality >= 2 && pressureRatio <= 3.0) return 'critical_raw';
  if (criticality >= 2) return 'compressible_critical';
  if (criticality >= 1) return 'compressible_critical';
  if (STEP_TYPES.includes(part.type ?? '')) return 'step_type';
  if (part.type === 'tool' && (part.state?.status === 'completed' || part.state?.type === 'completed')) {
    if (estimateTokens(String(part.state.output ?? '')) > 100) return 'compressible';
    if (pressureRatio > 1.0) return 'compressible';
    return 'short_tool_output';
  }
  if (part.type === 'text') {
    if (estimateTokens(String(part.text ?? '')) > 200) return 'compressible';
    if (pressureRatio > 1.0) return 'compressible';
    return 'short_text';
  }
  return 'other';
}

function estimateMessageTokens(messages: SdkMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.parts ?? []) {
      total += estimateTokens(String(part.text ?? part.state?.output ?? ''));
    }
  }
  return total;
}

function buildToolSummary(tool: string, input: Record<string, unknown>, lines: number): string {
   const formatLines = (count: number): string => {
     if (count < 1000) return `${count} lines`;
     const k = Math.ceil(count / 100) / 10;
     return `~${k}K lines`;
   };
   const formatResults = (count: number): string => {
     if (count < 1000) return `${count} results`;
     const k = Math.ceil(count / 100) / 10;
     return `~${k}K results`;
   };
   switch (tool) {
      case 'read': return `[TOOL:read] ${String(input.filePath ?? '')} — ${formatLines(lines)}`;
      case 'write': case 'edit': return `[TOOL:${tool}] ${String(input.filePath ?? '')} — applied`;
     case 'bash': return `[TOOL:bash] "${String(input.command ?? '').slice(0, 60)}" — ${formatLines(lines)}`;
     case 'grep': case 'glob': return `[TOOL:${tool}] "${String(input.pattern ?? '').slice(0, 40)}" — ${formatResults(lines)}`;
     case 'task': return `[TOOL:task] "${String(input.description ?? '').slice(0, 50)}" — completed`;
     default: return `[TOOL:${tool}] — ${formatLines(lines)}`;
   }
 }

function toolRiskAndSignals(tool: string, input: Record<string, unknown>, before: number): { risk: CompressedPartDetail['risk']; reason: string; signals: string[] } {
  if (tool === 'read') return { risk: 'low', reason: before > 1000 ? 'large_log' : 'old_tool_output', signals: ['file_path', 'line_count'] };
  if (tool === 'bash') return { risk: 'low', reason: 'large_log', signals: ['command', 'line_count'] };
  if (tool === 'edit' || tool === 'write') return { risk: 'medium', reason: 'old_tool_output', signals: ['file_path', 'status'] };
  if (tool === 'grep' || tool === 'glob') return { risk: 'low', reason: 'old_tool_output', signals: ['pattern', 'result_count'] };
  return { risk: 'low', reason: 'old_tool_output', signals: ['tool_name', 'line_count'] };
}

function compressToolOutput(part: SdkPart): CompressedPartDetail | null {
  if (part.state?.status !== 'completed' && part.state?.type !== 'completed') return null;
  const output = String(part.state.output ?? '');
  const before = estimateTokens(output);
  if (before <= 2) return null;
  const tool = part.tool ?? 'unknown';
  const input = part.state?.input ?? {};

  const criticality = scoreCriticality(part);
  if (before <= 8) {
    part.state.output = '[OK]';
    const after = 1;
    return {
      kind: `tool_${tool}`, source: input.filePath ?? input.command ?? input.pattern ?? '',
      reason: 'tiny_tool_output', beforeTokens: before, afterTokens: after,
      compressionRatio: after / before, preservedSignals: [], risk: 'low',
    };
  }

   const lineCount = output.split('\n').length;
   if (criticality >= 2) {
     const errLines = output.split('\n').slice(0, 15).join('\n');
    const summary = `[CRITICAL_TOOL:${tool}] ${input.filePath ?? input.command ?? ''}\n${errLines}`;
    const summaryTokens = estimateTokens(summary);
    if (summaryTokens < before) {
      part.state.output = summary;
    }
    const after = estimateTokens(String(part.state.output ?? ''));
    const meta = toolRiskAndSignals(tool, input, before);
    return {
      kind: `tool_${tool}`, source: input.filePath ?? input.command ?? input.pattern ?? '',
      reason: 'critical_content_preserved', beforeTokens: before, afterTokens: after,
      compressionRatio: before > 0 ? after / before : 0, preservedSignals: [...meta.signals, 'error_content'], risk: 'high',
    };
  }
  const summary = buildToolSummary(tool, input, lineCount);
  part.state.output = summary;
  const after = estimateTokens(String(part.state.output ?? ''));
  if (after >= before) return null;
  const meta = toolRiskAndSignals(tool, input, before);
  return {
    kind: `tool_${tool}`, source: input.filePath ?? input.command ?? input.pattern ?? '',
    reason: before > 100 ? meta.reason : 'old_short_tool_output', beforeTokens: before, afterTokens: after,
    compressionRatio: before > 0 ? after / before : 0, preservedSignals: meta.signals, risk: meta.risk,
  };
}

function compressTextPart(part: SdkPart): CompressedPartDetail | null {
  if (part.type !== 'text') return null;
  const text = String(part.text ?? '');
  const before = estimateTokens(text);
  if (before < 150) return null;
  const keep = text.slice(0, 500);
  part.text = `${keep}\n[COMPRESSED_CONTEXT: ${before} tok → ~${Math.ceil(keep.length / 4)} tok]`;
  const after = estimateTokens(part.text);
  return {
    kind: 'assistant_text', source: '', reason: 'stale_turn',
    beforeTokens: before, afterTokens: after, compressionRatio: after / before,
    preservedSignals: ['first_500_chars'], risk: 'low',
  };
}

function classifyAndCollect(
  messages: SdkMessage[], adaptiveWindow: number, pressureRatio: number,
): { candidates: { part: SdkPart; tokens: number }[]; pinnedCategories: Record<string, number> } {
  const candidates: { part: SdkPart; tokens: number }[] = [];
  const pinnedCategories: Record<string, number> = {};
  const totalMsgs = messages.length;
  for (let i = 0; i < totalMsgs; i++) {
    const role = messages[i].info?.role ?? 'unknown';
    for (const part of messages[i].parts ?? []) {
      const cls = classifyPart(part, i, totalMsgs, role, adaptiveWindow, pressureRatio);
      if (cls === 'compressible' || cls === 'compressible_critical') {
        candidates.push({ part, tokens: estimateTokens(String(part.text ?? part.state?.output ?? '')) });
      } else {
        pinnedCategories[cls] = (pinnedCategories[cls] ?? 0) + 1;
      }
    }
  }
  return { candidates, pinnedCategories };
}

function compressToFit(
  candidates: { part: any; tokens: number }[], target: number,
): { saved: number; details: CompressedPartDetail[] } {
  candidates.sort((a, b) => {
    const critA = scoreCriticality(a.part);
    const critB = scoreCriticality(b.part);
    if (critA !== critB) return critA - critB;
    return b.tokens - a.tokens;
  });
  let saved = 0;
  const details: CompressedPartDetail[] = [];
  for (const c of candidates) {
    if (saved >= target) break;
    const detail = c.part.type === 'tool' ? compressToolOutput(c.part) : compressTextPart(c.part);
    if (detail) { saved += detail.beforeTokens - detail.afterTokens; details.push(detail); }
  }
  return { saved, details };
}

/** Compile messages to fit within a token budget. */
export function compileContext(
  messages: SdkMessage[], config: ContextCompilerConfig,
): CompileResult {
  const empty: CompileResult = {
    beforeTokens: 0, afterTokens: 0, budget: 0, partsCompressed: 0, partsPinned: 0,
    mode: 'normal', compressedDetails: [], pinnedCategories: {},
  };
  if (!config.enabled) return empty;
  const budget = config.modes[config.defaultMode];
  const beforeTokens = estimateMessageTokens(messages);
  if (beforeTokens <= budget) {
    return { ...empty, beforeTokens, afterTokens: beforeTokens, budget, mode: config.defaultMode };
  }
  let adaptiveWindow = adaptiveRecentWindow(config.recentTurnWindow, beforeTokens, budget);
  let pressureRatio = beforeTokens / Math.max(budget, 1);
  let allDetails: CompressedPartDetail[] = [];
  let totalSaved = 0;
  for (let pass = 0; pass < 3; pass++) {
    const { candidates, pinnedCategories: _pinnedCategories } = classifyAndCollect(messages, adaptiveWindow, pressureRatio);
    const overBudget = beforeTokens - totalSaved - budget;
    if (overBudget <= 0) break;
    const { saved, details } = compressToFit(candidates, overBudget);
    totalSaved += saved;
    allDetails = allDetails.concat(details);
    if (saved === 0) {
      adaptiveWindow = Math.max(1, adaptiveWindow - 1);
      pressureRatio = (beforeTokens - totalSaved) / Math.max(budget, 1);
    }
  }
  const afterTokens = beforeTokens - totalSaved;
  const { pinnedCategories: finalPinned } = classifyAndCollect(messages, adaptiveWindow, pressureRatio);
  return {
    beforeTokens, afterTokens, budget,
    partsCompressed: allDetails.length, partsPinned: Object.values(finalPinned).reduce((a, b) => a + b, 0),
    mode: config.defaultMode, compressedDetails: allDetails, pinnedCategories: finalPinned,
  };
}

/** Format a compact status line for system prompt injection (Layer 1) */
export function formatStatusLine(result: CompileResult): string {
  const underBudget = result.afterTokens <= result.budget;
  const highRisk = result.compressedDetails.filter(d => d.risk === 'high').length;
  const riskFlag = highRisk > 0 ? ` ⚠${highRisk}high-risk` : '';
  return `[Context Compiler] ${result.mode} ${(result.beforeTokens / 1000).toFixed(1)}K→${(result.afterTokens / 1000).toFixed(1)}K | compressed=${result.partsCompressed} pinned=${result.partsPinned} under_budget=${underBudget}${riskFlag}`;
}

import { compileContext, compileContextWithLessons, type CompileResult } from './context-compiler.js';
import { AlchemistEngine } from './alchemist.js';
import { Redactor } from './redactor.js';
import { DEFAULT_CONFIG } from './config.js';
import { estimateTokens } from './token-bucket-analyzer.js';
import type { CompressedPartDetail, ContextCompilerConfig } from './types.js';

interface BenchmarkPart {
  type?: string;
  text?: string;
  tool?: string;
  state?: { status?: string; output?: string };
}

interface BenchmarkMessage {
  info: { role: string };
  parts: BenchmarkPart[];
}

interface BenchmarkReport {
  messageCount: number;
  baselineTokens: number;
  optimizedTokens: number;
  tokensSaved: number;
  reductionPct: number;
  effectiveContextMultiplier: number;
  toolOutputDominanceBefore: number;
  toolOutputDominanceAfter: number;
  criticalEvidenceRetained: number;
  redactionEnabled: boolean;
  redactionAudit: Record<string, number>;
  estimatedCostAvoided: number;
  partsCompressed: number;
  partsPinned: number;
  budgetMode: string;
}

const PROVIDER_COST_PER_1K_TOKENS = 0.005;

function makeToolOutput(text: string, lines: number = 50): string {
  return Array.from({ length: lines }, (_, i) => `Line ${i + 1}: ${text}`).join('\n');
}

function makeUserTurn(i: number): BenchmarkMessage {
  const tasks = [
    'Fix the authentication bug in the login flow',
    'Add unit tests for the memory manager',
    'Refactor the context compiler to support budget modes',
    'Implement the redaction layer for privacy',
    'Debug the checkpoint store race condition',
    'Optimize the hybrid search query performance',
    'Add concept extraction for function names',
    'Wire the Alchemist engine into the context pipeline',
    'Fix the rollover threshold calculation',
    'Add integration tests for the distilled summaries',
  ];
  return {
    info: { role: 'user' },
    parts: [{ type: 'text', text: tasks[i % tasks.length] }],
  };
}

function makeAssistantTurn(i: number): BenchmarkMessage {
  return {
    info: { role: 'assistant' },
    parts: [{ type: 'text', text: `Working on task ${i}. Let me read the relevant files first.` }],
  };
}

function makeToolOutputTurn(i: number): BenchmarkMessage {
  const tools = [
    { name: 'Read', content: makeToolOutput('export function authenticate(user: string) { ... }', 80) },
    { name: 'Bash', content: makeToolOutput('PASS 214 tests, 0 failures', 30) },
    { name: 'Grep', content: makeToolOutput('src/auth.ts:42: function validateToken(token)', 20) },
    { name: 'Edit', content: makeToolOutput('Edited src/memory-manager.ts — 3 file(s) changed', 10) },
    { name: 'Write', content: makeToolOutput('Wrote test/redactor.test.ts', 15) },
  ];
  const tool = tools[i % tools.length];
  return {
    info: { role: 'tool' },
    parts: [{ type: 'tool', tool: tool.name, state: { status: 'completed' as const, output: tool.content } }],
  };
}

function generateSession(count: number): BenchmarkMessage[] {
  const messages: BenchmarkMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(makeUserTurn(i));
    messages.push(makeAssistantTurn(i));
    messages.push(makeToolOutputTurn(i));
    if (i % 5 === 0) {
      messages.push(makeAssistantTurn(i + 100));
      messages.push(makeToolOutputTurn(i + 100));
    }
  }
  return messages;
}

function computeBaselineTokens(messages: BenchmarkMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      total += estimateTokens(part.text ?? String(part.state?.output ?? ''));
    }
  }
  return total;
}

function computeToolOutputDominance(messages: BenchmarkMessage[]): number {
  let toolTokens = 0;
  let totalTokens = 0;
  for (const msg of messages) {
    for (const part of msg.parts) {
      const tokens = part.type === 'tool'
        ? estimateTokens(String(part.state?.output ?? ''))
        : estimateTokens(part.text ?? '');
      totalTokens += tokens;
      if (part.type === 'tool') toolTokens += tokens;
    }
  }
  return totalTokens > 0 ? (toolTokens / totalTokens) * 100 : 0;
}

function extractEvidenceRetained(result: CompileResult): number {
  let retained = 0;
  for (const detail of result.compressedDetails ?? []) {
    retained += (detail as CompressedPartDetail).preservedSignals?.length ?? 0;
  }
  return retained;
}

function runBenchmark(
  messages: BenchmarkMessage[],
  config: ContextCompilerConfig,
  alchemist?: AlchemistEngine,
  redactor?: Redactor,
): BenchmarkReport {
  const baselineTokens = computeBaselineTokens(messages);
  const toolOutputDominanceBefore = computeToolOutputDominance(messages);

  const result = alchemist
    ? compileContextWithLessons(messages, config, alchemist, 500)
    : compileContext(messages, config);

  const optimizedTokens = result.afterTokens;
  const tokensSaved = baselineTokens - optimizedTokens;
  const reductionPct = baselineTokens > 0 ? (tokensSaved / baselineTokens) * 100 : 0;
  const effectiveContextMultiplier = optimizedTokens > 0 ? baselineTokens / optimizedTokens : 0;

  const toolCompressedTokens = result.compressedDetails.filter(d => d.kind.startsWith('tool_')).reduce((s, d) => s + d.afterTokens, 0);
  const toolOriginalTokens = result.compressedDetails.filter(d => d.kind.startsWith('tool_')).reduce((s, d) => s + d.beforeTokens, 0);
  const totalAfterTokens = result.afterTokens + (baselineTokens - toolOriginalTokens);
  const toolOutputDominanceAfter = totalAfterTokens > 0 ? (toolCompressedTokens / totalAfterTokens) * 100 : 0;
  const criticalEvidenceRetained = extractEvidenceRetained(result);

  let redactionAudit: Record<string, number> = {};
  if (redactor) {
    const sample = 'API key: sk-proj-abc123def456ghi789jkl012mno345; Email: dev@example.com';
    const redactResult = redactor.redact(sample);
    redactionAudit = redactResult.audit.byCategory;
  }

  const estimatedCostAvoided = (tokensSaved / 1000) * PROVIDER_COST_PER_1K_TOKENS;

  return {
    messageCount: messages.length,
    baselineTokens,
    optimizedTokens,
    tokensSaved,
    reductionPct,
    effectiveContextMultiplier,
    toolOutputDominanceBefore,
    toolOutputDominanceAfter,
    criticalEvidenceRetained,
    redactionEnabled: !!redactor,
    redactionAudit,
    estimatedCostAvoided,
    partsCompressed: result.partsCompressed,
    partsPinned: result.partsPinned,
    budgetMode: result.mode,
  };
}

function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  REPRODUCIBLE BENCHMARK — Long Session Context Compilation');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Messages:              ${report.messageCount}`);
  lines.push(`  Budget mode:           ${report.budgetMode}`);
  lines.push('');
  lines.push('─── Token Economics ───────────────────────────────────────────');
  lines.push(`  Baseline tokens:       ${report.baselineTokens.toLocaleString()}`);
  lines.push(`  Optimized tokens:      ${report.optimizedTokens.toLocaleString()}`);
  lines.push(`  Tokens saved:          ${report.tokensSaved.toLocaleString()}`);
  lines.push(`  Reduction:             ${report.reductionPct.toFixed(1)}%`);
  lines.push(`  Context multiplier:    ${report.effectiveContextMultiplier.toFixed(1)}x`);
  lines.push(`  Est. cost avoided:     $${report.estimatedCostAvoided.toFixed(2)}`);
  lines.push('');
  lines.push('─── Context Composition ──────────────────────────────────────');
  lines.push(`  Parts compressed:      ${report.partsCompressed}`);
  lines.push(`  Parts pinned:          ${report.partsPinned}`);
  lines.push(`  Tool-output dominance: ${report.toolOutputDominanceBefore.toFixed(1)}% → ${report.toolOutputDominanceAfter.toFixed(1)}%`);
  lines.push(`  Evidence retained:     ${report.criticalEvidenceRetained} signals`);
  lines.push('');
  lines.push('─── Privacy / Redaction ──────────────────────────────────────');
  lines.push(`  Redaction enabled:     ${report.redactionEnabled}`);
  if (report.redactionEnabled) {
    for (const [cat, count] of Object.entries(report.redactionAudit)) {
      lines.push(`  ${cat.padEnd(22)} ${count}`);
    }
  }
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  return lines.join('\n');
}

export function runBenchmarkSuite(messageCount: number = 877): BenchmarkReport {
  const messages = generateSession(messageCount);
  const config = {
    ...DEFAULT_CONFIG.contextCompiler,
    budgetMode: 'normal' as const,
  };
  const redactor = new Redactor(DEFAULT_CONFIG.redactor);
  const alchemist = new AlchemistEngine();
  return runBenchmark(messages, config, alchemist, redactor);
}

export { formatReport, generateSession, runBenchmark, type BenchmarkReport };

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = runBenchmarkSuite(877);
  // eslint-disable-next-line no-console -- benchmark CLI output is intentional
  console.log(formatReport(report));
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildResumeInjection } from '../src/work-journal-inject.js';
import type { ResumePayload } from '../src/work-journal-types.js';
import { estimateTokens } from '../src/token-bucket-analyzer.js';

function payload(): ResumePayload {
  return {
    fromSessionId: 'resume-session-123456',
    fromProjectId: 'cross-session-memory',
    lastActiveAt: new Date('2026-06-29T12:00:00Z'),
    totalEntries: 12,
    entries: Array.from({ length: 12 }, (_, index) => ({
      entryType: 'tool_call' as const,
      toolName: index % 2 === 0 ? 'bash' : 'edit',
      intent: `continue phase ${index} with detailed status and repeated filler ${'x'.repeat(60)}`,
      target: index % 2 === 0 ? `src/file-${index}.ts` : `docs/generated-${index}.md`,
      resultSummary: `result ${index} ${'y'.repeat(40)}`,
      errorSummary: undefined,
      filesTouched: [`src/file-${index}.ts`, `docs/generated-${index}.md`],
      createdAt: new Date('2026-06-29T12:00:00Z'),
    })),
    activeGoal: 'Cut prompt usage while preserving task continuity.',
    nextStepInferred: 'Wire the budget governor into prompt assembly.',
    allFilesTouched: [
      'src/context-budget-governor.ts',
      'src/evidence-vault.ts',
      'docs/SYSTEM_MAP.md',
      'src/hooks/tool-execute-budget.ts',
      'test/tool-execute-budget.test.ts',
      'docs/CHANGELOG_LIVE.md',
      'src/work-journal-inject.ts',
      'src/checkpoint-inject.ts',
      'src/prompt-budget-injection.ts',
    ],
    tokenCount: 3000,
  };
}

describe('buildResumeInjection', () => {
  it('distills entries and file lists to stay within budget', () => {
    const injection = buildResumeInjection(payload(), { maxInjectTokens: 180 });
    assert.equal(estimateTokens(injection) <= 180, true);
    assert.match(injection, /Active Goal/);
    assert.match(injection, /Inferred Next Step/);
    assert.match(injection, /files distilled for budget|Resume truncated for budget/);
    assert.doesNotMatch(injection, /docs\/SYSTEM_MAP\.md/);
  });
});

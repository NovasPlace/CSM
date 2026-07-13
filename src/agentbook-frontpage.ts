import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentBookCurrentState,
  AgentBookEvent,
  AgentBookFrontPage,
  AgentBookRule,
  AgentBookSummary,
} from './agentbook-types.js';
import { AGENTBOOK_STATE_FILENAME } from './agentbook-types.js';

function bullets(values: string[], empty: string): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : [`- ${empty}`];
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function formatRule(rule: AgentBookRule): string {
  const trigger = rule.trigger ? ` when ${rule.trigger}` : '';
  return `P${rule.priority} [${rule.scope}/${rule.overridePolicy}] ${rule.instruction}${trigger}`;
}

function recentWork(events: AgentBookEvent[]): string[] {
  return events.slice(0, 10).map((event) => {
    const files = event.files.length > 0 ? ` — ${event.files.join(', ')}` : '';
    return `[${event.eventType}] ${event.summary}${files}`;
  });
}

function knownProblems(state: AgentBookCurrentState, summary: AgentBookSummary | null): string[] {
  return unique([
    ...state.blockers,
    ...(summary?.failures ?? []).map((failure) => `Failure: ${failure}`),
    ...(summary?.openQuestions ?? []).map((question) => `Open question: ${question}`),
  ]);
}

function nextActions(state: AgentBookCurrentState, summary: AgentBookSummary | null): string[] {
  const candidates = state.nextSteps.length > 0 ? state.nextSteps : summary?.nextSteps ?? [];
  return unique(candidates);
}

export function generateFrontPage(
  state: AgentBookCurrentState,
  latestSummary: AgentBookSummary | null,
  rules: AgentBookRule[],
  recentEvents: AgentBookEvent[],
): AgentBookFrontPage {
  const problems = knownProblems(state, latestSummary);
  const actions = nextActions(state, latestSummary);
  const activeRules = rules.filter((rule) => rule.active)
    .sort((left, right) => right.priority - left.priority || left.ruleId.localeCompare(right.ruleId));
  const lines = [
    '# AgentBook — Current State',
    '',
    '## Project',
    state.projectId,
    '',
    '## Active Goal',
    state.activeGoal ?? 'No active goal recorded.',
    '',
    '## Current State',
    `- Phase: ${state.currentPhase ?? 'Not recorded'}`,
    `- Events: ${state.eventCount}`,
    `- Sessions: ${state.sessionCount}`,
    `- Latest summary: ${latestSummary?.summaryId ?? 'None'}`,
    `- Updated: ${state.updatedAt}`,
    '',
    '## Recent Work',
    ...bullets(recentWork(recentEvents), 'No recent work recorded.'),
    '',
    '## Known Problems',
    ...bullets(problems, 'No active blockers or known failures.'),
    '',
    '## Rules',
    ...bullets(activeRules.map(formatRule), 'No active AgentBook rules.'),
    '',
    '## Next Action',
    ...bullets(actions, 'Define the next concrete action.'),
    '',
  ];
  const markdown = lines.join('\n');
  return {
    markdown,
    hash: createHash('sha256').update(markdown).digest('hex'),
    eventCount: state.eventCount,
    summaryId: latestSummary?.summaryId ?? null,
    rulesVersion: state.rulesVersion,
    generatedAt: new Date().toISOString(),
  };
}

export function writeFrontPageFile(markdown: string, projectRoot: string): string {
  const outputPath = resolve(projectRoot, AGENTBOOK_STATE_FILENAME);
  writeFileSync(outputPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8');
  return outputPath;
}

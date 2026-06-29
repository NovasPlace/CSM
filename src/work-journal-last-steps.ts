import type { ResumeEntry } from './work-journal-types.js';

export function buildLastSteps(entries: ResumeEntry[], maxSteps: number): string[] {
  const steps: string[] = [];
  for (const entry of entries) {
    const step = describeStep(entry);
    if (!step || steps.includes(step)) continue;
    steps.push(step);
    if (steps.length >= maxSteps) break;
  }
  return steps;
}

function describeStep(entry: ResumeEntry): string {
  const prefix = `[${entry.entryType}${entry.toolName ? `:${entry.toolName}` : ''}]`;
  const action = entry.intent.trim();
  const target = entry.target ? ` -> ${truncate(entry.target, 80)}` : '';
  const result = entry.resultSummary ? ` | ${truncate(entry.resultSummary, 100)}` : '';
  const error = entry.errorSummary ? ` | ERROR: ${truncate(entry.errorSummary, 100)}` : '';
  return `${prefix} ${truncate(action, 160)}${target}${result}${error}`.trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

import { estimateTokens } from './token-bucket-analyzer.js';

interface BenchmarkPart {
  type?: string;
  text?: string;
  tool?: string;
  state?: Record<string, unknown>;
}

export interface BenchmarkMessage {
  info: { role: string };
  parts: BenchmarkPart[];
}

export interface ScenarioFacts {
  goal: string;
  phase: string;
  files: string[];
  failedTest: string;
  nextStep: string;
  decisions: string[];
}

function msg(role: string, text: string, tool = false): BenchmarkMessage {
  return tool
    ? { info: { role }, parts: [{ type: 'tool', tool: 'bash', state: { status: 'completed', output: text, input: { command: 'npm test' } } }] }
    : { info: { role }, parts: [{ type: 'text', text }] };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function countTokens(messages: BenchmarkMessage[]): number {
  return messages.reduce((sum, message) =>
    sum + message.parts.reduce((partSum, part) => partSum + estimateTokens(String(part.text ?? part.state?.output ?? '')), 0), 0);
}

export function toolShare(messages: BenchmarkMessage[]): number {
  let total = 0;
  let tool = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      const tokens = estimateTokens(String(part.text ?? part.state?.output ?? ''));
      total += tokens;
      if (part.type === 'tool') tool += tokens;
    }
  }
  return total > 0 ? tool / total : 0;
}

export function buildScenario(turns: number): { messages: BenchmarkMessage[]; facts: ScenarioFacts } {
  const facts: ScenarioFacts = {
    goal: 'Implement Adaptive Context Governor',
    phase: '32',
    files: ['src/context-governor.ts', 'src/index.ts', 'test/context-governor.test.ts'],
    failedTest: 'continuity rebuild does not preserve next step',
    nextStep: 'benchmark governor vs baseline',
    decisions: ['use deterministic thresholds', 'preserve checkpoint refs before rebuild'],
  };
  const messages: BenchmarkMessage[] = [
    msg('assistant', `Goal: ${facts.goal}`),
    msg('assistant', `Phase: ${facts.phase}`),
    msg('assistant', `Files: ${facts.files.join(', ')}`),
    msg('assistant', `Failed test: ${facts.failedTest}`),
    msg('assistant', `Next step: ${facts.nextStep}`),
    ...facts.decisions.map((decision) => msg('assistant', `Decision: ${decision}`)),
  ];
  for (let index = 0; index < turns; index++) {
    messages.push(msg('user', `Continue Phase 32 turn ${index}`));
    messages.push(msg('assistant', `Working turn ${index}. Keep the governor under budget.`));
    messages.push(msg('assistant', `read ${facts.files[index % facts.files.length]} ${'x'.repeat(2500)}`, true));
  }
  return { messages, facts };
}

export function evaluateContinuity(messages: BenchmarkMessage[], facts: ScenarioFacts) {
  const text = messages.flatMap((message) => message.parts).map((part) => String(part.text ?? part.state?.output ?? '')).join('\n');
  const required = [
    `Goal: ${facts.goal}`,
    `Phase: ${facts.phase}`,
    `Files: ${facts.files[0]}`,
    `Failed test: ${facts.failedTest}`,
    `Next step: ${facts.nextStep}`,
  ];
  const missingFacts = required.filter((item) => !text.includes(item));
  const missingDecisions = facts.decisions.filter((decision) => !text.includes(decision));
  return {
    repeatedWorkCount: missingFacts.length + missingDecisions.length,
    forgottenDecisionCount: missingDecisions.length,
    continuitySurvived: missingFacts.length === 0,
    finalBuildTestResult: text.includes(facts.failedTest) ? 'failing error preserved' : 'failing error lost',
  };
}

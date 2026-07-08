import { estimateTokens } from './token-bucket-analyzer.js';

interface GovernorPart {
  type?: string;
  text?: string;
  tool?: string;
  state?: { output?: string };
}

interface MessageLike {
  info?: { role?: string };
  parts?: GovernorPart[];
}

function textOf(part: GovernorPart): string {
  return String(part.text ?? part.state?.output ?? '');
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/x{12,}/g, '<blob>')
    .replace(/\s+/g, ' ')
    .trim();
}

function primaryPath(text: string): string {
  const match = text.match(/[A-Za-z0-9_./-]+\.(ts|tsx|js|jsx|json|md|sql)/);
  return match?.[0] ?? '';
}

function primaryError(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => /error|fail|warn/i.test(entry));
  return line?.slice(0, 80) ?? '';
}

function signalLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /error|fail|warn|next step|decision|goal|phase|src\/|test\//i.test(line))
    .slice(0, 3);
}

function distilledToolText(part: GovernorPart): string {
  const output = textOf(part);
  const tool = String(part.tool ?? 'tool');
  const path = primaryPath(output);
  const error = primaryError(output);
  const signal = signalLines(output)[0] ?? '';
  const summary = error || signal || output.replace(/\s+/g, ' ').slice(0, 48);
  const size = estimateTokens(output);
  const pathText = path ? ` path=${path}` : '';
  return `[TOOL_DISTILLED:${tool}] tok=${size}${pathText} keep=${summary}`.trim();
}

function dedupeRef(text: string): string {
  return `[DEDUP_REF] ${text.slice(0, 120)}`;
}

function toolSignature(part: GovernorPart): string {
  const output = textOf(part);
  const tool = String(part.tool ?? 'tool');
  const path = primaryPath(output);
  const error = primaryError(output);
  return normalize(`${tool}|${path}|${error}`);
}

function shouldSkipPart(part: GovernorPart): boolean {
  const text = textOf(part);
  return text.length === 0
    || /^\[(MEMORY_BRIEF|CHECKPOINT_REF|DISTILLED_STATE|TOOL_DISTILLED|DEDUP_REF)/.test(text);
}

export function optimizeGovernorContext(messages: MessageLike[], recentWindow: number): void {
  const seen = new Map<string, number>();
  const seenTools = new Map<string, number>();
  const keepFrom = Math.max(0, messages.length - recentWindow);
  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const role = messages[msgIndex].info?.role ?? 'assistant';
    for (const part of messages[msgIndex].parts ?? []) {
      if (shouldSkipPart(part) || role === 'user') continue;
      const text = textOf(part);
      const key = normalize(text);
      const firstSeen = seen.get(key);
      if (firstSeen !== undefined && msgIndex < keepFrom) {
        if (part.type === 'tool') part.state!.output = dedupeRef(text);
        else part.text = dedupeRef(text);
        continue;
      }
      seen.set(key, msgIndex);
      if (part.type !== 'tool' || msgIndex >= keepFrom) continue;
      const signature = toolSignature(part);
      const priorTool = seenTools.get(signature);
      if (priorTool !== undefined) {
        part.state!.output = `[TOOL_DEDUP_REF:${String(part.tool ?? 'tool')}] ${primaryPath(text) || 'repeat'}`;
        continue;
      }
      seenTools.set(signature, msgIndex);
      if (estimateTokens(text) < 80) continue;
      part.state!.output = distilledToolText(part);
    }
  }
}

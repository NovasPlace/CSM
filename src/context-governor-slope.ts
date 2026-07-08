import { estimateTokens } from './token-bucket-analyzer.js';

interface SlopePart {
  text?: string;
  state?: Record<string, unknown>;
}

interface MessageLike {
  parts?: SlopePart[];
}

function messageTokens(message: MessageLike): number {
  return (message.parts ?? [])
    .reduce((sum, part) => sum + estimateTokens(String(part.text ?? part.state?.output ?? '')), 0);
}

export function estimateSlopeGrowth(messages: MessageLike[]): number {
  const sample = messages.slice(-6).map(messageTokens);
  if (sample.length < 3) return 0;
  const deltas: number[] = [];
  for (let index = 1; index < sample.length; index++) {
    deltas.push(Math.max(0, sample[index] - sample[index - 1]));
  }
  const positive = deltas.filter((delta) => delta > 0);
  if (positive.length === 0) return 0;
  return Math.round(positive.reduce((sum, delta) => sum + delta, 0) / positive.length);
}

import { buildCheckpoint } from './checkpoint-builder.js';
import { estimateTokens } from './token-bucket-analyzer.js';
import type { CheckpointConfig, SessionMessage } from './checkpoint-types.js';

interface CheckpointPart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  toolCallId?: string;
  state?: Record<string, unknown>;
  output?: string;
  input?: unknown;
  error?: string;
}

interface MessageLike {
  info?: { role?: string; id?: string; sessionID?: string };
  parts?: CheckpointPart[];
}

const CHECKPOINT_CONFIG: CheckpointConfig = {
  enabled: true,
  maxCheckpointInjectTokens: 1200,
  minMessagesBeforeInject: 1,
  maxRawCaptureBytes: 4096,
  maxRawCapturesPerCheckpoint: 50,
};

function toSessionMessage(message: MessageLike, index: number): SessionMessage {
  return {
    info: {
      id: message.info?.id ?? `governor-msg-${index}`,
      role: message.info?.role ?? 'assistant',
    },
    parts: (message.parts ?? []).map((part, partIndex) => ({
      id: part.id,
      type: part.type ?? 'text',
      text: part.text,
      tool: part.tool,
      callID: part.callID ?? part.toolCallId ?? `tool-${index}-${partIndex}`,
      state: part.state,
      output: part.output ?? part.state?.output,
      input: part.input ?? part.state?.input,
      error: (part.error ?? part.state?.error) as string | undefined,
    })),
  };
}

function buildPayload(messages: MessageLike[]) {
  return buildCheckpoint({
    sessionId: 'governor-benchmark',
    projectId: null,
    messages: messages.map(toSessionMessage),
    config: CHECKPOINT_CONFIG,
  }).checkpoint;
}

function findFacts(messages: MessageLike[], pattern: RegExp, limit: number): string[] {
  const hits: string[] = [];
  for (const message of [...messages].reverse()) {
    for (const part of message.parts ?? []) {
      const text = String(part.text ?? part.state?.output ?? '');
      const match = text.match(pattern);
      if (match?.[0] && !hits.includes(match[0])) hits.push(match[0]);
      if (hits.length >= limit) return hits.reverse();
    }
  }
  return hits.reverse();
}

function factHeader(messages: MessageLike[]): string {
  return [
    ...findFacts(messages, /Goal:[^\n]+/i, 1),
    ...findFacts(messages, /Phase:[^\n]+/i, 1),
    ...findFacts(messages, /Files?:[^\n]+/i, 1),
    ...findFacts(messages, /(Error|Failed test):[^\n]+/i, 1),
    ...findFacts(messages, /Next step:[^\n]+/i, 1),
    ...findFacts(messages, /Decision:[^\n]+/i, 3),
  ].join('\n');
}

function trunc(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  return estimateTokens(text) > maxTokens
    ? `${text.slice(0, maxChars)}\n... [checkpoint truncated]`
    : text;
}

function queryTerms(messages: MessageLike[]): string[] {
  return messages
    .slice(-3)
    .flatMap((message) => message.parts ?? [])
    .map((part) => String(part.text ?? part.state?.output ?? '').toLowerCase())
    .join(' ')
    .match(/[a-z][a-z0-9_./-]{2,}/g)
    ?.slice(0, 20) ?? [];
}

function rankedRefs(messages: MessageLike[]) {
  const checkpoint = buildPayload(messages);
  const terms = queryTerms(messages);
  return checkpoint.sourceRefs
    .map((ref) => ({
      ref,
      score: terms.some((term) => `${ref.kind} ${ref.note} ${ref.toolCallId ?? ''}`.toLowerCase().includes(term)) ? 2 : 0,
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.ref);
}

export function buildCheckpointRefSummary(messages: MessageLike[]): string {
  const refs = rankedRefs(messages)
    .slice(0, 8)
    .map((ref) => `[CHECKPOINT_REF] role=${ref.role} kind=${ref.kind} note=${ref.note}`)
    .join('\n');
  const checkpoint = buildPayload(messages);
  const summary = trunc(checkpoint.summaryMarkdown, 220);
  return `${factHeader(messages)}\n${summary}\n${refs || '[CHECKPOINT_REF] none available'}`.trim();
}

export function buildCheckpointDistilledState(messages: MessageLike[]): string {
  const checkpoint = buildPayload(messages);
  return `${factHeader(messages)}\n${trunc(checkpoint.summaryMarkdown, 180)}`.trim();
}

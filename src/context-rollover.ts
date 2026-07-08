/**
 * Phase 6 — Context Rollover: main orchestrator.
 *
 * Tracks cumulative tokens per session. When the threshold is exceeded,
 * archives old messages into the context cache, builds a continuation brief,
 * and replaces old messages with brief + last N turns.
 * Fails closed if the transformed prompt remains over cap.
 */
import { DatabasePool } from './types.js';
import { RolloverConfig } from './context-rollover-config.js';
import type { Redactor } from './redactor.js';
import { estimateTokens } from './token-bucket-analyzer.js';
import { storeItem } from './context-cache-store.js';
import { buildContinuationBrief } from './context-rollover-brief.js';
import {
  getRolloverRecord,
  upsertCumulativeTokens,
  recordRollover,
  setHardRolloverFlag,
} from './context-rollover-schema.js';

interface RolloverPart {
  type?: string;
  text?: string;
  output?: string;
  state?: { output?: string };
  id?: string;
  sessionID?: string;
  messageID?: string;
  synthetic?: boolean;
  metadata?: Record<string, unknown>;
}

interface MessageLike {
  info?: Record<string, unknown> & { role?: string; sessionID?: string };
  parts?: RolloverPart[];
}

export interface RolloverResult {
  rolloverTriggered: boolean;
  auditLine: string;
  messages: MessageLike[];
  cumulativeTokens: number;
  briefTokens: number;
  archivedTokens: number;
  newPromptTokens: number;
  failClosed: boolean;
}

const NO_ROLLOVER: Pick<RolloverResult, 'rolloverTriggered' | 'auditLine' | 'briefTokens' | 'archivedTokens' | 'newPromptTokens' | 'failClosed'> = {
  rolloverTriggered: false,
  auditLine: '',
  briefTokens: 0,
  archivedTokens: 0,
  newPromptTokens: 0,
  failClosed: false,
};

function extractAllText(parts: RolloverPart[] | undefined): string {
  if (!parts) return '';
  const chunks: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') chunks.push(p.text);
    if (p.type === 'tool') {
      if (typeof p.output === 'string') chunks.push(p.output);
      if (p.state?.output && typeof p.state.output === 'string') chunks.push(p.state.output);
    }
  }
  return chunks.join('\n');
}

function estimateMessageTokens(messages: MessageLike[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(extractAllText(m.parts));
  }
  return total;
}

function findTurnsCutoff(messages: MessageLike[], turnsToKeep: number): number {
  let userCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info?.role === 'user') {
      userCount++;
      if (userCount >= turnsToKeep) return i;
    }
  }
  return 0;
}

async function archiveOldMessages(
  pool: DatabasePool,
  sessionId: string,
  messages: MessageLike[],
  redactor?: Redactor,
): Promise<number> {
  let archivedTokens = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const text = extractAllText(m.parts);
    if (!text.trim()) continue;
    const tokens = estimateTokens(text);
    const displayId = `rollover_turn_${i}`;
    const summary = text.slice(0, 120).replace(/\n/g, ' ');
    await storeItem(pool, {
      sessionId,
      displayId,
      kind: 'turn',
      createdAt: Date.now(),
      messageIndex: i,
      summary,
      content: text,
      tokens,
    }, redactor);
    archivedTokens += tokens;
  }
  return archivedTokens;
}

function cloneSyntheticPart(template: RolloverPart | undefined, briefText: string, sessionId: string, messageId: string): RolloverPart {
  if (template?.type === 'text') {
    return {
      type: 'text',
      id: `${messageId}-brief`,
      sessionID: sessionId,
      messageID: messageId,
      text: briefText,
      synthetic: true,
      metadata: {
        contextRolloverBrief: true,
      },
    };
  }
  return {
    id: `${messageId}-brief`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text: briefText,
    synthetic: true,
    metadata: { contextRolloverBrief: true },
  };
}

function buildBriefMessage(sessionId: string, briefText: string, recentMessages: MessageLike[]): MessageLike {
  const template = recentMessages.find((msg) => msg.info?.role === 'assistant');
  const baseInfo = template?.info
    ? { ...template.info }
    : {
      role: 'assistant',
      sessionID: sessionId,
      time: { created: Date.now() },
      parentID: '',
      modelID: 'synthetic',
      providerID: 'synthetic',
      mode: 'default',
      agent: 'cross-session-memory',
      path: { cwd: '', root: '' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };
  const messageId = `${sessionId}-rollover-brief-${Date.now()}`;
  const partTemplate = template?.parts?.find((part) => part?.type === 'text')
    ?? recentMessages.find((msg) => msg.info?.role === 'user')?.parts?.find((part) => part?.type === 'text');
  return {
    info: {
      ...baseInfo,
      id: messageId,
      role: 'assistant',
      sessionID: sessionId,
      time: { created: Date.now() },
      summary: undefined,
    },
    parts: [cloneSyntheticPart(partTemplate, briefText, sessionId, messageId)],
  };
}

function formatAuditLine(
  briefTokens: number,
  archivedTokens: number,
  rolloverCount: number,
  newPromptTokens: number,
  failClosed: boolean,
): string {
  const status = failClosed ? 'FAIL-CLOSED' : 'OK';
  return `[Context Rollover #${rolloverCount}] brief=${briefTokens}tok archived=${archivedTokens}tok newPrompt=${newPromptTokens}tok status=${status}`;
}

async function executeRollover(
  pool: DatabasePool,
  sessionId: string,
  messages: MessageLike[],
  config: RolloverConfig,
  record: { rollover_count: number },
  _redactor?: Redactor,
): Promise<RolloverResult> {
  const cutoff = findTurnsCutoff(messages, config.recentTurnsToKeep);
  const oldMessages = messages.slice(0, cutoff);
  const recentMessages = messages.slice(cutoff);

  if (oldMessages.length === 0) {
    const cum = messages.reduce((s, m) => s + estimateTokens(extractAllText(m.parts)), 0);
    return {
      ...NO_ROLLOVER,
      messages,
      cumulativeTokens: cum,
      auditLine: '[Context Rollover] threshold exceeded but no old messages to archive',
    };
  }

  const archivedTokens = await archiveOldMessages(pool, sessionId, oldMessages);
  const brief = buildContinuationBrief(oldMessages, config, sessionId);
  const briefMessage = buildBriefMessage(sessionId, brief.text, recentMessages);
  const newMessages = [briefMessage, ...recentMessages];
  const newPromptTokens = estimateMessageTokens(newMessages);
  const failClosed = newPromptTokens > config.failClosedOverInputTokens;
  const newCount = record.rollover_count + 1;

  await recordRollover(pool, sessionId, brief.tokens, archivedTokens);

  // Phase 2: If fail-closed, signal autocontinue hook for hard rollover
  if (failClosed) {
    await setHardRolloverFlag(pool, sessionId, brief.text);
  }

  return {
    rolloverTriggered: true,
    auditLine: formatAuditLine(brief.tokens, archivedTokens, newCount, newPromptTokens, failClosed),
    messages: newMessages,
    cumulativeTokens: brief.tokens,
    briefTokens: brief.tokens,
    archivedTokens,
    newPromptTokens,
    failClosed,
  };
}

export async function performRollover(
  pool: DatabasePool,
  sessionId: string,
  messages: MessageLike[],
  rawTotalTokens: number,
  cfg: RolloverConfig,
  redactor?: Redactor,
): Promise<RolloverResult> {
  const record = await getRolloverRecord(pool, sessionId);
  const currentPromptTokens = rawTotalTokens;
  const newCumulative = record.cumulative_tokens + currentPromptTokens;

  if (newCumulative < cfg.rolloverAtTotalSessionTokens) {
    await upsertCumulativeTokens(pool, sessionId, newCumulative);
    return { ...NO_ROLLOVER, messages, cumulativeTokens: newCumulative };
  }

  const result = await executeRollover(pool, sessionId, messages, cfg, record, redactor);
  if (!result.rolloverTriggered) {
    await upsertCumulativeTokens(pool, sessionId, newCumulative);
  }
  return result;
}

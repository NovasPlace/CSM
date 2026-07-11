import type { PluginInput } from '@opencode-ai/plugin';
import { randomUUID } from 'node:crypto';
import { classifyFreeTextDecision } from '../free-text-decision-classifier.js';
import { getLogger } from '../logger.js';
import type { PluginContext } from '../plugin-context.js';
import { rememberUserTurn } from './reentry-source-only.js';

interface MessageInfo { id: string; role: string; sessionID?: string }
interface MessagePart { type: string; text?: string }
interface SdkMessage { info: { id: string }; parts?: MessagePart[] }

export async function handleMessageUpdated(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  event: Record<string, unknown>,
): Promise<void> {
  if (event.type !== 'message.updated') return;
  const info = (event.properties as Record<string, unknown>).info as MessageInfo | undefined;
  getLogger().debug(`message.updated fired - role: ${info?.role}, id: ${info?.id}`,
    { turnId: info?.id });
  if (!info) return;
  if (info.role === 'user' && pluginCtx.state.currentSessionId) {
    await captureUserDecision(ctx, pluginCtx, info);
  }
  if (info.role === 'assistant' && pluginCtx.config.fullTranscripts) {
    await captureAssistantMessage(ctx, pluginCtx, info);
  }
}

async function captureUserDecision(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  info: MessageInfo,
): Promise<void> {
  try {
    const message = await loadMessage(ctx, info);
    const userText = textContent(message);
    if (!userText.trim()) return;
    const sessionId = String(info.sessionID ?? pluginCtx.state.currentSessionId);
    rememberUserTurn(pluginCtx.state, sessionId, userText);
    const classification = classifyFreeTextDecision(userText);
    if (!classification) return;
    await pluginCtx.experiencePackets.recordDecisionPacket({
      sessionId: pluginCtx.state.currentSessionId!, projectId: ctx.directory,
      intent: classification.intent, decisionKind: classification.decisionKind,
      confidence: classification.confidence,
      signalsMetadata: { _schemaVersion: 1, _sourceHook: 'event-hook',
        _correlationId: randomUUID(), _evidenceRefs: [{ kind: 'message_id', id: info.id }],
        trigger_pattern: classification.pattern },
    });
  } catch {
    getLogger().warn('free-text decision packet write failed', {});
  }
}

async function captureAssistantMessage(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  info: MessageInfo,
): Promise<void> {
  try {
    const message = await loadMessage(ctx, info);
    const content = textContent(message);
    const previous = pluginCtx.state.capturedMessageSizes.get(info.id) ?? 0;
    if (!content.trim() || content.length <= previous) return;
    rememberCapture(pluginCtx, info.id, content.length);
    pluginCtx.state.messageCount += 1;
    await persistAssistant(ctx, pluginCtx, info, message, content);
  } catch (error) {
    getLogger().error('Messages transform error', error as Error);
  }
}

async function persistAssistant(
  ctx: PluginInput,
  pluginCtx: PluginContext,
  info: MessageInfo,
  message: SdkMessage | undefined,
  content: string,
): Promise<void> {
  await pluginCtx.memoryManager.saveMemory({
    content: `[assistant] ${content.trim()}`, type: 'conversation',
    importance: importance(content), source: 'auto',
    tags: ['auto-captured', 'conversation', 'full-transcript', 'assistant'],
    metadata: { messageId: info.id, role: 'assistant', fullTranscript: true,
      partCount: message?.parts?.length ?? 0 },
    sessionId: String(info.sessionID ?? ''),
  });
  pluginCtx.workJournal.recordDecision({
    sessionId: String(info.sessionID ?? ''), projectId: ctx.directory,
    intent: content.trim().substring(0, 200), filesTouched: [],
  });
}

async function loadMessage(
  ctx: PluginInput,
  info: MessageInfo,
): Promise<SdkMessage | undefined> {
  const result = await ctx.client.session.messages({ path: { id: String(info.sessionID ?? '') } });
  return (result.data as SdkMessage[] | undefined)?.find((message) => message.info.id === info.id);
}

function textContent(message: SdkMessage | undefined): string {
  return message?.parts?.filter((part) => part.type === 'text')
    .map((part) => part.text ?? '').join('\n') ?? '';
}

function rememberCapture(pluginCtx: PluginContext, id: string, length: number): void {
  const sizes = pluginCtx.state.capturedMessageSizes;
  sizes.set(id, length);
  if (sizes.size <= 500) return;
  const recent = [...sizes.entries()].slice(-250);
  sizes.clear();
  recent.forEach(([messageId, size]) => sizes.set(messageId, size));
}

function importance(content: string): number {
  const lower = content.toLowerCase();
  if (lower.includes('decision') || lower.includes('solution')) return 0.6;
  if (lower.includes('error') || lower.includes('fix') || lower.includes('bug')) return 0.5;
  return 0.3;
}

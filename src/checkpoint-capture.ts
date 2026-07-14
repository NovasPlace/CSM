// Phase 4A — raw content capture for checkpoint recovery
// Extracted from checkpoint-builder.ts to stay under 200 LOC.
// Captures current tool outputs and long assistant text for later expansion.
import { estimateTokens } from './token-bucket-analyzer.js';
import { SessionMessage, SessionPart, StoreRawInput, CheckpointConfig } from './checkpoint-types.js';

/** Collect raw captures from current message state (post-v1-compaction). */
export function collectRawCaptures(msgs: SessionMessage[], cfg: CheckpointConfig): StoreRawInput[] {
  const captures: StoreRawInput[] = [];
  for (const m of msgs) {
    for (const p of m.parts ?? []) {
      if (captures.length >= cfg.maxRawCapturesPerCheckpoint) break;
      const cap = capturePart(m, p, cfg.maxRawCaptureBytes);
      if (cap) captures.push(cap);
    }
  }
  return captures;
}

/** Estimate total tokens across all message parts. */
export function estimateInputTokens(msgs: SessionMessage[]): number {
  let total = 0;
  for (const m of msgs) {
    for (const p of m.parts ?? []) {
      if (p.type === 'text') total += estimateTokens(p.text ?? '');
      else if (p.type === 'tool') {
        const value = toolPartContent(p);
        total += estimateTokens(value);
      }
    }
  }
  return total;
}

function capturePart(msg: SessionMessage, p: SessionPart, maxBytes: number): StoreRawInput | null {
  const mid = msg.info?.id;
  const role = msg.info?.role ?? 'unknown';
  if (p.type === 'tool' && (p.state?.status === 'completed' || p.state?.status === 'error')) {
    const content = toolPartContent(p);
    if (content.trim().length === 0) return null;
    return {
      checkpointId: '',
      messageId: mid,
      partId: p.id,
      toolCallId: p.callID ?? p.toolCallId,
      kind: 'tool_output',
      content: content.slice(0, maxBytes),
      tokenCount: estimateTokens(content),
    };
  }
  if (p.type === 'text' && role === 'assistant' && (p.text ?? '').length > 800) {
    const content = p.text ?? '';
    return {
      checkpointId: '', messageId: mid, kind: 'assistant_text',
      content: content.slice(0, maxBytes), tokenCount: estimateTokens(content),
    };
  }
  return null;
}


function toolPartContent(p: SessionPart): string {
  const value = p.state?.status === 'error'
    ? p.state?.error ?? p.error ?? ''
    : p.state?.output ?? p.output ?? '';
  return typeof value === 'string' ? value : JSON.stringify(value ?? '');
}

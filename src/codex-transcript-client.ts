import { readFile } from 'node:fs/promises';

interface TranscriptPart { type: string; text?: string }
export interface CodexTranscriptMessage {
  info: { id: string; role: string; createdAt?: string };
  parts: TranscriptPart[];
}

export class CodexTranscriptClient {
  private readonly paths = new Map<string, string>();

  readonly client = {
    session: {
      messages: async ({ path }: { path: { id: string } }) => ({
        data: await this.messages(path.id),
      }),
    },
  };

  setTranscriptPath(sessionId: string, transcriptPath: string | undefined): void {
    if (transcriptPath) this.paths.set(sessionId, transcriptPath);
  }

  async messages(sessionId: string): Promise<CodexTranscriptMessage[]> {
    const transcriptPath = this.paths.get(sessionId);
    if (!transcriptPath) return [];
    let source: string;
    try {
      source = await readFile(transcriptPath, 'utf8');
    } catch {
      return [];
    }
    const messages: CodexTranscriptMessage[] = [];
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        collectMessages(JSON.parse(line), messages, `codex-${index}`);
      } catch {
        // Transcript format is intentionally treated as best-effort.
      }
    }
    return dedupeMessages(messages);
  }
}

function collectMessages(value: unknown, target: CodexTranscriptMessage[], fallbackId: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectMessages(item, target, `${fallbackId}-${index}`));
    return;
  }
  const record = value as Record<string, unknown>;
  const role = messageRole(record);
  const text = messageText(record);
  if (role && text) {
    target.push({
      info: {
        id: stringValue(record.id) ?? stringValue(record.message_id) ?? fallbackId,
        role,
        createdAt: stringValue(record.created_at) ?? stringValue(record.timestamp),
      },
      parts: [{ type: 'text', text }],
    });
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === 'content' || key === 'message' || key === 'text') continue;
    collectMessages(child, target, `${fallbackId}-${key}`);
  }
}

function messageRole(record: Record<string, unknown>): string | undefined {
  const direct = stringValue(record.role);
  if (direct === 'user' || direct === 'assistant' || direct === 'system') return direct;
  const type = stringValue(record.type);
  if (type === 'user_message') return 'user';
  if (type === 'assistant_message') return 'assistant';
  return undefined;
}

function messageText(record: Record<string, unknown>): string | undefined {
  const direct = stringValue(record.text) ?? stringValue(record.message);
  if (direct) return direct;
  if (typeof record.content === 'string') return record.content;
  if (!Array.isArray(record.content)) return undefined;
  const parts = record.content.flatMap((item) => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    const part = item as Record<string, unknown>;
    return [stringValue(part.text) ?? stringValue(part.content) ?? ''];
  }).filter(Boolean);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function dedupeMessages(messages: CodexTranscriptMessage[]): CodexTranscriptMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    const key = `${message.info.id}:${message.info.role}:${message.parts[0]?.text ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

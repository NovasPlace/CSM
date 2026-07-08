export interface SanitizedPart {
  type?: string;
  text?: string;
  id?: string;
  sessionID?: string;
  messageID?: string;
  [key: string]: unknown;
}

export interface PromptMessageLike {
  info?: Record<string, unknown> & {
    role?: string;
    sessionID?: string;
  };
  parts?: SanitizedPart[];
}

export interface PromptNormalizationOptions {
  cwd: string;
  root: string;
  sessionID?: string;
  agent?: string;
  model?: {
    providerID: string;
    modelID: string;
  };
}

type PromptMessageNormalizationResult = {
  messages: PromptMessageLike[];
  convertedSystemMessages: number;
  droppedMessages: number;
};

const EMPTY_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const USER_SAFE_PART_TYPES = new Set(['text', 'file', 'image', 'audio']);
const ASSISTANT_SAFE_PART_TYPES = new Set(['text', 'tool-call']);
const TOOL_SAFE_PART_TYPES = new Set(['tool-result']);

function isAllowedPartType(role: string, type: string): boolean {
  if (role === 'user') return USER_SAFE_PART_TYPES.has(type);
  if (role === 'assistant' || role === 'system') return ASSISTANT_SAFE_PART_TYPES.has(type);
  if (role === 'tool') return TOOL_SAFE_PART_TYPES.has(type);
  return false;
}

function normalizeParts(parts: SanitizedPart[], role: string, sessionID: string, messageID: string): SanitizedPart[] {
  const normalized: SanitizedPart[] = [];

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (!part || typeof part !== 'object' || typeof part.type !== 'string') continue;
    if (!isAllowedPartType(role, part.type)) continue;

    if (part.type === 'text') {
      if (typeof part.text !== 'string') continue;
      normalized.push({
        ...part,
        id: typeof part.id === 'string' ? part.id : `${messageID}-text-${index}`,
        sessionID: typeof part.sessionID === 'string' ? part.sessionID : sessionID,
        messageID: typeof part.messageID === 'string' ? part.messageID : messageID,
      });
      continue;
    }

    normalized.push(part);
  }

  return normalized;
}

function normalizeUserInfo(
  info: PromptMessageLike['info'],
  sessionID: string,
  agent: string,
  model: { providerID: string; modelID: string },
) {
  const time = typeof info?.time === 'object' && info.time ? info.time : {};
  return {
    ...info,
    role: 'user',
    sessionID,
    id: typeof info?.id === 'string' ? info.id : `${sessionID}-user-${Date.now()}`,
    time: { created: Number((time as { created?: number }).created ?? Date.now()) },
    agent: typeof info?.agent === 'string' ? info.agent : agent,
    model: typeof info?.model === 'object' && info.model ? info.model : model,
  };
}

function normalizeAssistantInfo(
  info: PromptMessageLike['info'],
  sessionID: string,
  cwd: string,
  root: string,
  agent: string,
) {
  const time = typeof info?.time === 'object' && info.time ? info.time : {};
  return {
    ...info,
    role: 'assistant',
    sessionID,
    id: typeof info?.id === 'string' ? info.id : `${sessionID}-assistant-${Date.now()}`,
    time: {
      ...time,
      created: Number((time as { created?: number }).created ?? Date.now()),
    },
    parentID: typeof info?.parentID === 'string' ? info.parentID : '',
    modelID: typeof info?.modelID === 'string' ? info.modelID : 'synthetic',
    providerID: typeof info?.providerID === 'string' ? info.providerID : 'synthetic',
    mode: typeof info?.mode === 'string' ? info.mode : 'default',
    agent: typeof info?.agent === 'string' ? info.agent : agent,
    path: typeof info?.path === 'object' && info.path ? info.path : { cwd, root },
    cost: typeof info?.cost === 'number' ? info.cost : 0,
    tokens: typeof info?.tokens === 'object' && info.tokens ? info.tokens : EMPTY_TOKENS,
  };
}

export function normalizePromptMessages(
  messages: PromptMessageLike[],
  options: PromptNormalizationOptions,
): PromptMessageNormalizationResult {
  const normalized: PromptMessageLike[] = [];
  let convertedSystemMessages = 0;
  let droppedMessages = 0;
  const sessionID = options.sessionID ?? 'unknown';
  const agent = options.agent ?? 'cross-session-memory';
  const model = options.model ?? { providerID: 'synthetic', modelID: 'synthetic' };

  for (const message of messages) {
    const role = message?.info?.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      droppedMessages++;
      continue;
    }

    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      droppedMessages++;
      continue;
    }

    const resolvedSessionID = typeof message.info?.sessionID === 'string' && message.info.sessionID
      ? message.info.sessionID
      : sessionID;

    if (role === 'user') {
      const info = normalizeUserInfo(message.info, resolvedSessionID, agent, model);
      const parts = normalizeParts(message.parts, role, resolvedSessionID, String(info.id));
      if (parts.length === 0) {
        droppedMessages++;
        continue;
      }
      normalized.push({
        ...message,
        info,
        parts,
      });
      continue;
    }

    if (role === 'system') convertedSystemMessages++;
    const info = normalizeAssistantInfo(message.info, resolvedSessionID, options.cwd, options.root, agent);
    const parts = normalizeParts(message.parts, role, resolvedSessionID, String(info.id));
    if (parts.length === 0) {
      droppedMessages++;
      continue;
    }
    normalized.push({
      ...message,
      info,
      parts,
    });
  }

  return { messages: normalized, convertedSystemMessages, droppedMessages };
}

import type { PluginInput } from '@opencode-ai/plugin';
import type { PluginContext } from '../plugin-context.js';
import { getLogger } from '../logger.js';
import {
  buildSourceOnlyInjectedText,
  disableToolsForSourceOnlyTurn,
  extractTextParts,
  isReentrySourceOnlyTurn,
  rememberUserTurn,
} from './reentry-source-only.js';
import {
  handleFileEdited,
  handleSessionCreated,
  handleSessionUpdated,
} from './event-session-handlers.js';
import { handleMessageUpdated } from './event-message-handlers.js';

export function createEventHook(
  ctx: PluginInput,
  pluginCtx: PluginContext,
): (args: { event: unknown }) => Promise<void> {
  return async ({ event }) => {
    const record = event as Record<string, unknown>;
    try {
      await handleSessionCreated(ctx, pluginCtx, record);
      await handleSessionUpdated(ctx, pluginCtx, record);
      await handleFileEdited(pluginCtx, record);
      await handleMessageUpdated(ctx, pluginCtx, record);
    } catch (error) {
      getLogger().error('Event handler failed', error as Error);
    }
  };
}

export function createChatMessageHook(
  pluginCtx: PluginContext,
): (input: {
  sessionID: string;
  model?: { providerID: string; modelID: string };
}, output: { parts: unknown[] }) => Promise<void> {
  return async (input, output) => {
    captureModelIdentity(pluginCtx, input);
    const userText = extractTextParts(output.parts);
    if (userText) rememberUserTurn(pluginCtx.state, input.sessionID, userText);
    if (!isReentrySourceOnlyTurn(userText)) return;
    const message = sourceOnlyMessage(output);
    if (!message) return;
    disableToolsForSourceOnlyTurn(message);
    const block = await pluginCtx.reEntryProtocol?.buildBlockForSourceOnlyTurn(
      input.sessionID, pluginCtx.directory,
    );
    const sourceOnlySystem = buildSourceOnlyInjectedText(block);
    message.system = message.system
      ? `${sourceOnlySystem}\n\n${message.system}` : sourceOnlySystem;
  };
}

function captureModelIdentity(
  pluginCtx: PluginContext,
  input: { sessionID: string; model?: { providerID: string; modelID: string } },
): void {
  if (!input.model || pluginCtx.state.modelIdPinned) return;
  const modelId = `${input.model.providerID}:${input.model.modelID}`;
  pluginCtx.state.currentModelId = modelId;
  pluginCtx.state.modelIdBySession?.set(input.sessionID, modelId);
}

function sourceOnlyMessage(output: { parts: unknown[] }): {
  id?: string;
  sessionID?: string;
  system?: string;
  tools?: Record<string, boolean>;
} | undefined {
  return (output as { message?: {
    id?: string; sessionID?: string; system?: string; tools?: Record<string, boolean>;
  } }).message;
}

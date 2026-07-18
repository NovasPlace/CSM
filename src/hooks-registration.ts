import type { Hooks, PluginInput, PluginOptions } from '@opencode-ai/plugin';
import { validateAndReturnConfig, validatePluginConfig } from './config.js';
import { createChatMessageHook, createEventHook } from './hooks/event-hooks.js';
import { createMessagesTransformHook } from './hooks/messages-transform.js';
import { createPermissionAskHook, createToolExecuteAfterHook,
  createToolExecuteBeforeHook } from './hooks/tool-execute.js';
import { createAutocontinueHook, createSessionCompactingHook } from './hooks/session-compaction.js';
import { createSystemTransformHook } from './hooks/system-transform.js';
import { registerTools } from './hooks/tool-hooks.js';
import { disposeAll } from './hooks/dispose-hooks.js';
import { Logger, withLogContext } from './logger.js';
import type { PluginContext } from './plugin-context.js';
import { startPluginContext } from './plugin-runtime-start.js';
import { mergePluginConfig, normalizeProviderRuntimeConfig } from './provider-runtime-config.js';

export async function registerHooks(
  ctx: PluginInput,
  options?: PluginOptions,
  _defaultExports: unknown = {},
): Promise<Hooks> {
  const merged = mergePluginConfig(validateAndReturnConfig(), options);
  const config = normalizeProviderRuntimeConfig(validatePluginConfig(merged));
  const logging = new Logger({
    sessionId: undefined, projectId: ctx.directory ?? null, verbose: config.promptDebug,
  });
  logging.info('Initializing AUTOMATED memory system...');
  return withLogContext({ projectId: ctx.directory }, () => startPluginContext<Hooks>(ctx, config, logging, {
    activate: (pluginCtx) => {
      logContextCap(config.targetContextCap, logging);
      return buildHooks(ctx, pluginCtx);
    },
  }));
}

function buildHooks(ctx: PluginInput, pluginCtx: PluginContext): Hooks {
  return {
    event: createEventHook(ctx, pluginCtx),
    'chat.message': createChatMessageHook(pluginCtx),
    'permission.ask': createPermissionAskHook(pluginCtx),
    'experimental.chat.system.transform': createSystemTransformHook(pluginCtx),
    'experimental.chat.messages.transform': createMessagesTransformHook(pluginCtx),
    'experimental.session.compacting': createSessionCompactingHook(pluginCtx),
    'experimental.compaction.autocontinue': createAutocontinueHook(pluginCtx),
    'tool.execute.before': createToolExecuteBeforeHook(pluginCtx),
    'tool.execute.after': createToolExecuteAfterHook(pluginCtx),
    tool: registerTools(pluginCtx) as unknown as Hooks['tool'],
    dispose: () => disposeAll(ctx, pluginCtx),
  };
}

function logContextCap(target: number, logging: Logger): void {
  if (target <= 0) return;
  logging.info(`Context cap target: ${target} tokens. Set compaction.reserved in opencode.json to (model_input_limit - ${target}) to enforce. Also enable compaction.prune=true for free context pruning.`);
}

export { CSM_TOOL_NAMES } from './tool-names.js';

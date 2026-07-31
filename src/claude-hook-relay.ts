import {
  codexHookEndpoint,
  startCodexHookRelay,
  type CodexHookRelay,
} from './codex-hook-relay.js';
import type { CodexNativeRuntimeManager } from './codex-native-runtime.js';
import { CLAUDE_HOST_PROFILE } from './native-host-profile.js';

/**
 * Claude-profile convenience wrappers over the host-neutral relay. The endpoint
 * is derived from the Claude pipe prefix plus the plugin-root hash, so a Claude
 * bundle never shares a transport with the Codex bundle or with another Claude
 * workspace rooted at a different path.
 */
export function claudeHookEndpoint(pluginRoot?: string): string {
  return codexHookEndpoint(pluginRoot, CLAUDE_HOST_PROFILE);
}

/**
 * Start the lifecycle relay for a Claude-profile runtime manager. The manager
 * must be constructed with CLAUDE_HOST_PROFILE; the relay reads its profile to
 * select the transport name.
 */
export function startClaudeHookRelay(manager: CodexNativeRuntimeManager): Promise<CodexHookRelay> {
  return startCodexHookRelay(manager);
}

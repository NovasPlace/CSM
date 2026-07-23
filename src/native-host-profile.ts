/**
 * Host profile seam for the native CSM lifecycle runtime.
 *
 * The native relay, runtime, and lifecycle hooks are host-neutral. The only
 * host-specific values are a handful of strings (transport pipe prefix, default
 * session id, agent/message identifiers, the human host label, and the
 * relay-unavailable fallback message). Those are collected here so a single
 * profile object can be threaded through the shared internals instead of
 * scattering `if (claude)` branches or duplicating the modules per host.
 *
 * The Codex profile carries the exact strings the runtime used before the seam;
 * `test/codex-native-golden.test.ts` locks that behavior.
 */
export interface HostProfile {
  /** Stable host identity. Used as the agent name, message id prefix, and model fallback. */
  hostName: 'codex' | 'claude';
  /** Named-pipe / unix-socket basename prefix. The plugin-root hash is appended for isolation. */
  pipePrefix: string;
  /** Session id used when the host does not supply one. */
  defaultSessionId: string;
  /** Human-facing host label used in operator-visible messages. */
  clientLabel: string;
  /** SessionStart fallback shown when the lifecycle relay is unreachable. */
  restartMessage: string;
}

export const CODEX_HOST_PROFILE: HostProfile = {
  hostName: 'codex',
  pipePrefix: 'csm-codex-',
  defaultSessionId: 'codex-default',
  clientLabel: 'Codex',
  restartMessage:
    'CSM native runtime is installed but its lifecycle relay is not running. Restart Codex to reload the plugin.',
};

export const CLAUDE_HOST_PROFILE: HostProfile = {
  hostName: 'claude',
  pipePrefix: 'csm-claude-',
  defaultSessionId: 'claude-default',
  clientLabel: 'Claude Code',
  restartMessage:
    'CSM native runtime is installed but its lifecycle relay is not running. Restart Claude Code to reload the plugin.',
};

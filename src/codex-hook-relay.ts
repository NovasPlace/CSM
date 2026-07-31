import { createHash } from 'node:crypto';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCodexNativeHook, type CodexHookPayload } from './codex-native-hooks.js';
import type { CodexNativeRuntimeManager } from './codex-native-runtime.js';
import { CODEX_HOST_PROFILE, type HostProfile } from './native-host-profile.js';
import { redactSensitiveText } from './sensitive-redaction.js';

export interface CodexHookRelay {
  endpoint: string;
  close(): Promise<void>;
}

export function codexHookEndpoint(
  pluginRoot = configuredPluginRoot(),
  profile: HostProfile = CODEX_HOST_PROFILE,
): string {
  const digest = createHash('sha256').update(pluginRoot.toLowerCase()).digest('hex').slice(0, 16);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${profile.pipePrefix}${digest}`
    : join(tmpdir(), `${profile.pipePrefix}${digest}.sock`);
}

export async function startCodexHookRelay(
  manager: CodexNativeRuntimeManager,
): Promise<CodexHookRelay> {
  const endpoint = codexHookEndpoint(configuredPluginRoot(), manager.profile);
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let source = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('error', () => undefined);
    socket.on('data', (chunk) => {
      if (handled) return;
      source += chunk;
      const boundary = source.indexOf('\n');
      if (boundary < 0) return;
      handled = true;
      void respond(socket, source.slice(0, boundary), manager);
    });
    socket.on('end', () => {
      if (handled) return;
      handled = true;
      void respond(socket, source, manager);
    });
  });
  server.on('error', (error) => {
    process.stderr.write(`CSM hook relay error: ${redactSensitiveText(error.message)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') resolve();
      else reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint);
  });
  return {
    endpoint,
    close: () => new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    }),
  };
}

async function respond(
  socket: net.Socket,
  source: string,
  manager: CodexNativeRuntimeManager,
): Promise<void> {
  try {
    const payload = JSON.parse(source) as CodexHookPayload;
    safeEnd(socket, JSON.stringify(await handleCodexNativeHook(payload, manager)));
  } catch (error) {
    safeEnd(socket, JSON.stringify({
      continue: true,
      systemMessage: `CSM lifecycle hook failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
    }));
  }
}

function safeEnd(socket: net.Socket, value: string): void {
  if (socket.destroyed) return;
  socket.end(value);
}

function configuredPluginRoot(): string {
  return process.env.PLUGIN_ROOT
    ?? process.env.CSM_PLUGIN_ROOT
    ?? process.env.CLAUDE_PLUGIN_ROOT
    ?? process.cwd();
}

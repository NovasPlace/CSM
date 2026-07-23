import net from 'node:net';
import { codexHookEndpoint } from '../codex-hook-relay.js';
import { parseCodexHookOutput, toCodexHookOutput } from '../codex-hook-output.js';
import type { HostProfile } from '../native-host-profile.js';

/**
 * Host-neutral lifecycle hook client. Reads a hook payload on stdin, forwards it
 * to the running relay for the given host, and writes the host wire-format result
 * to stdout. If the relay is unreachable it emits a safe continue (with the host's
 * restart hint on SessionStart) so the host session is never blocked.
 */
export async function runNativeHookClient(profile: HostProfile): Promise<void> {
  const source = await readStdin();
  let event = '';
  try {
    event = String((JSON.parse(source) as { hook_event_name?: unknown }).hook_event_name ?? '');
  } catch {
    // The relay reports malformed payloads when reachable.
  }

  try {
    process.stdout.write(parseCodexHookOutput(await relay(source, profile), event));
  } catch {
    const fallback = event === 'SessionStart'
      ? { continue: true, systemMessage: profile.restartMessage }
      : { continue: true };
    process.stdout.write(JSON.stringify(toCodexHookOutput(fallback, event)));
  }
}

function relay(payload: string, profile: HostProfile): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(codexHookEndpoint(undefined, profile));
    let result = '';
    const timeout = setTimeout(() => socket.destroy(new Error('CSM hook relay timed out.')), 25_000);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${payload.trim()}\n`));
    socket.on('data', (chunk) => { result += chunk; });
    socket.on('end', () => {
      clearTimeout(timeout);
      resolve(result || JSON.stringify({ continue: true }));
    });
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { value += chunk; });
    process.stdin.on('end', () => resolve(value));
    process.stdin.on('error', reject);
  });
}

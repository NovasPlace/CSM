import readline from 'node:readline';
import { CodexMemoryBridge } from './codex-bridge.js';
import { invokeMcpTool, MCP_TOOLS } from './codex-mcp-tools.js';
import { startCodexHookRelay, type CodexHookRelay } from './codex-hook-relay.js';
import { CodexNativeRuntimeManager } from './codex-native-runtime.js';
import {
  createCodexNativeToolCatalog,
  isCodexNativeTool,
} from './codex-native-tool-catalog.js';
import { setClientIdentity } from './bridge-provenance.js';
import { withLogContext } from './logger.js';
import { redactSensitiveText } from './sensitive-redaction.js';
import { defaultConfigForDirectory } from './config.js';
import type { HostProfile } from './native-host-profile.js';

const SERVER_NAME = 'Cross-Session Memory';
const SERVER_VERSION = '2.0.0';
const NATIVE_TOOLS = createCodexNativeToolCatalog();
const ALL_TOOLS = mergeToolCatalogs(MCP_TOOLS, NATIVE_TOOLS);

type JsonRpcId = number | string;

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id: JsonRpcId, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code: -32602, message: redactSensitiveText(message) } });
}

function textResult(payload: unknown) {
  // MCP requires `structuredContent` to be a JSON object:
  //   structuredContent?: { [key: string]: unknown }
  // Several tools return a bare array (list_memories, recall_lessons), which
  // schema-validating clients reject. Wrap any non-object payload under `result`.
  const isPlainObject =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: isPlainObject ? (payload as Record<string, unknown>) : { result: payload },
  };
}

/**
 * Run the full CSM MCP server + lifecycle hook relay over stdio for a given host.
 *
 * The behavior is host-neutral; the {@link HostProfile} only selects the relay
 * transport name and the host label in the initialize `instructions`. Codex and
 * Claude entrypoints are thin wrappers over this single implementation so the
 * transport, tool catalog, and lifecycle behavior cannot drift between hosts.
 */
export function runNativeMcpServer(profile: HostProfile): void {
  let bridgePromise: Promise<CodexMemoryBridge> | null = null;
  const nativeRuntimes = new CodexNativeRuntimeManager(profile);
  let hookRelayPromise: Promise<CodexHookRelay> | null = startCodexHookRelay(nativeRuntimes)
    .catch((error: unknown) => {
      process.stderr.write(`CSM hook relay failed to start: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`);
      throw error;
    });

  function getBridge(projectRoot?: string): Promise<CodexMemoryBridge> {
    bridgePromise ??= CodexMemoryBridge.connect(defaultConfigForDirectory(projectRoot));
    return bridgePromise;
  }

  async function handle(message: { id?: JsonRpcId; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; clientInfo?: { name?: string; version?: string } } }) {
    if (message.method === 'initialize' && message.id !== undefined) {
      setClientIdentity(message.params?.clientInfo);
      sendResult(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: `Full Cross-Session Memory runtime: memory, governance, living state, beliefs, self-model, AgentBook, checkpoints, context cache, goals, work ledger, re-entry, and ${profile.clientLabel} lifecycle automation.`,
      });
      return;
    }
    if (message.method === 'ping' && message.id !== undefined) return sendResult(message.id, {});
    if (message.method === 'tools/list' && message.id !== undefined) return sendResult(message.id, { tools: ALL_TOOLS });
    if (message.method === 'tools/call' && message.id !== undefined) {
      try {
        const name = message.params?.name ?? '';
        const args = message.params?.arguments ?? {};
        const result = isCodexNativeTool(name)
          ? await nativeRuntimes.execute(name, {
            projectRoot: requiredString(args.projectRoot, 'projectRoot'),
            sessionId: stringValue(args.sessionId),
            transcriptPath: stringValue(args.transcriptPath),
            args,
          })
          : await invokeMcpTool(await getBridge(stringValue(args.projectRoot) ?? stringValue(args.projectId)), name, args);
        sendResult(message.id, textResult(result));
      } catch (error) {
        sendError(message.id, error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (message.id !== undefined) sendError(message.id, `Method not found: ${message.method ?? 'unknown'}`);
  }

  async function cleanup(): Promise<void> {
    const tasks: Promise<unknown>[] = [nativeRuntimes.dispose()];
    if (bridgePromise) tasks.push(bridgePromise.then((bridge) => bridge.disconnect()));
    if (hookRelayPromise) tasks.push(hookRelayPromise.then((relay) => relay.close()));
    await Promise.allSettled(tasks);
    hookRelayPromise = null;
  }

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  let shutdownPromise: Promise<void> | null = null;

  input.on('line', (line) => {
    if (!line.trim()) return;
    const task = handleLine(line).finally(() => pending.delete(task));
    pending.add(task);
  });

  input.on('close', () => {
    void shutdown().catch((error: unknown) => {
      process.stderr.write(`CSM MCP shutdown failed: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}\n`);
      process.exitCode = 1;
    });
  });

  process.on('SIGINT', () => shutdown().finally(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().finally(() => process.exit(0)));

  async function handleLine(line: string): Promise<void> {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    try {
      const request = message as {
        id?: JsonRpcId;
        method?: string;
        params?: {
          name?: string;
          arguments?: Record<string, unknown>;
          protocolVersion?: string;
          clientInfo?: { name?: string; version?: string };
        };
      };
      const argumentsRecord = request.params?.arguments;
      await withLogContext({
        projectId: stringValue(argumentsRecord?.projectRoot),
        sessionId: stringValue(argumentsRecord?.sessionId),
        toolName: request.params?.name,
        correlationId: request.id === undefined ? undefined : String(request.id),
      }, () => handle(request));
    } catch (error) {
      const id = (message as { id?: JsonRpcId }).id ?? null;
      send({
        jsonrpc: '2.0', id,
        error: {
          code: -32603,
          message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
        },
      });
    }
  }

  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      await Promise.allSettled([...pending]);
      await cleanup();
    })();
    return shutdownPromise;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value)?.trim();
  if (!result) throw new Error(`${name} must be a non-empty string.`);
  return result;
}

function mergeToolCatalogs<T extends { name: string }>(
  bridgeTools: readonly T[],
  nativeTools: readonly T[],
): T[] {
  const tools = new Map<string, T>();
  bridgeTools.forEach((tool) => tools.set(tool.name, tool));
  nativeTools.forEach((tool) => tools.set(tool.name, tool));
  return [...tools.values()];
}

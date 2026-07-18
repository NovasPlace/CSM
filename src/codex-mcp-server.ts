import readline from 'node:readline';
import { CodexMemoryBridge } from './codex-bridge.js';
import { invokeMcpTool, MCP_TOOLS } from './codex-mcp-tools.js';
import { setClientIdentity } from './bridge-provenance.js';
import { withLogContext } from './logger.js';
import { redactSensitiveText } from './sensitive-redaction.js';

const SERVER_NAME = 'Cross-Session Memory Bridge';
const SERVER_VERSION = '1.0.0';

type JsonRpcId = number | string;

let bridgePromise: Promise<CodexMemoryBridge> | null = null;

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

function getBridge(): Promise<CodexMemoryBridge> {
  bridgePromise ??= CodexMemoryBridge.connect();
  return bridgePromise;
}

async function handle(message: { id?: JsonRpcId; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string; clientInfo?: { name?: string; version?: string } } }) {
  if (message.method === 'initialize' && message.id !== undefined) {
    setClientIdentity(message.params?.clientInfo);
    sendResult(message.id, {
      protocolVersion: message.params?.protocolVersion ?? '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'Cross-session memory tools backed by the existing Postgres bridge.',
    });
    return;
  }
  if (message.method === 'ping' && message.id !== undefined) return sendResult(message.id, {});
  if (message.method === 'tools/list' && message.id !== undefined) return sendResult(message.id, { tools: MCP_TOOLS });
  if (message.method === 'tools/call' && message.id !== undefined) {
    try {
      const bridge = await getBridge();
      sendResult(message.id, textResult(await invokeMcpTool(bridge, message.params?.name ?? '', message.params?.arguments ?? {})));
    } catch (error) {
      sendError(message.id, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (message.id !== undefined) sendError(message.id, `Method not found: ${message.method ?? 'unknown'}`);
}

async function cleanup(): Promise<void> {
  if (!bridgePromise) return;
  const bridge = await bridgePromise;
  await bridge.disconnect();
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await Promise.allSettled([...pending]);
    await cleanup();
  })();
  return shutdownPromise;
}

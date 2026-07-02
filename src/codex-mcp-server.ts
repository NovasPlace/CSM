import readline from 'node:readline';
import { CodexMemoryBridge } from './codex-bridge.js';
import { invokeMcpTool, MCP_TOOLS } from './codex-mcp-tools.js';

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
  send({ jsonrpc: '2.0', id, error: { code: -32602, message } });
}

function textResult(payload: unknown) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function getBridge(): Promise<CodexMemoryBridge> {
  bridgePromise ??= CodexMemoryBridge.connect();
  return bridgePromise;
}

async function handle(message: { id?: JsonRpcId; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } }) {
  if (message.method === 'initialize' && message.id !== undefined) {
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
input.on('line', (line) => {
  if (!line.trim()) return;
  handle(JSON.parse(line) as { id?: JsonRpcId; method?: string; params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string } })
    .catch((error: unknown) => send({ jsonrpc: '2.0', error: { code: -32603, message: String(error) } }));
});

process.on('SIGINT', () => cleanup().finally(() => process.exit(0)));
process.on('SIGTERM', () => cleanup().finally(() => process.exit(0)));

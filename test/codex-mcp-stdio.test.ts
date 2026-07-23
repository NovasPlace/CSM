import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

interface JsonRpcRecord {
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

describe('Codex MCP stdio transport', () => {
  it('keeps stdout JSON-only, reports parse errors, and exits when stdin closes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'csm-mcp-stdio-'));
    const databasePath = join(directory, 'bridge.sqlite');
    const child = spawn(process.execPath, [join(process.cwd(), 'dist', 'codex-mcp-server.js')], {
      cwd: directory,
      env: {
        ...process.env,
        CSM_DATABASE_PROVIDER: 'sqlite',
        CSM_SQLITE_PATH: databasePath,
        CSM_EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_HOST: 'http://127.0.0.1:11434',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.stdin.write('{broken json\n');
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', clientInfo: { name: 'stdio-test', version: '1' } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'csm_runtime_status', arguments: { projectRoot: directory } },
    })}\n`);
    child.stdin.end();

    const exitCode = await waitForExit(child, 120_000);
    try {
      assert.equal(exitCode, 0, stderr || stdout);
      const lines = stdout.split(/\r?\n/u).filter(Boolean);
      const records = lines.map((line) => JSON.parse(line) as JsonRpcRecord);
      assert.equal(records.length, 3, stdout);
      assert.equal(records.find((record) => record.error?.code === -32700)?.id, null);
      assert.ok(records.some((record) => record.id === 1 && record.result), stdout);
      assert.ok(records.some((record) => record.id === 2 && record.result), stdout);
      assert.doesNotMatch(stdout, /\[(?:INFO|WARN|ERROR|DEBUG)\]/u);
      assert.match(stderr, /Connected to SQLite/u);
      assert.match(stderr, /tool:csm_runtime_status correlation:2/u);
    } finally {
      if (!child.killed) child.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function waitForExit(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

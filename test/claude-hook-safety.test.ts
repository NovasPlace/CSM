import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const client = join(process.cwd(), 'dist', 'cli', 'claude-hook-client.js');

/**
 * The lifecycle hook client must never block or crash the host, and must always
 * emit a single valid JSON hook result — even with malformed, empty, or oversized
 * input and no relay reachable. Each run uses a unique plugin root so the derived
 * pipe has no listener, forcing the relay-unreachable fallback path.
 */
function runClient(payload: string): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const root = mkdtempSync(join(tmpdir(), 'csm-hook-safety-'));
    const child = spawn(process.execPath, [client], {
      env: { ...process.env, CLAUDE_PLUGIN_ROOT: root, CSM_PLUGIN_ROOT: root, PLUGIN_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    const timer = setTimeout(() => child.kill(), 40_000);
    child.once('error', (error) => { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); reject(error); });
    child.once('exit', (code) => { clearTimeout(timer); rmSync(root, { recursive: true, force: true }); resolve({ stdout, code }); });
    child.stdin.end(payload);
  });
}

function parseSingle(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/u).filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one JSON line, got: ${stdout}`);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe('Claude hook client safety (relay unreachable)', () => {
  it('emits the restart fallback as valid context on SessionStart', async () => {
    const { stdout, code } = await runClient(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd: '/x' }));
    assert.equal(code, 0);
    const output = parseSingle(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    assert.match(String(output.hookSpecificOutput?.additionalContext), /Restart Claude Code/u);
  });

  it('emits a safe continue on malformed JSON', async () => {
    const { stdout, code } = await runClient('{ this is not json ');
    assert.equal(code, 0);
    assert.deepEqual(parseSingle(stdout), { continue: true });
  });

  it('emits a safe continue on empty input', async () => {
    const { stdout, code } = await runClient('');
    assert.equal(code, 0);
    assert.deepEqual(parseSingle(stdout), { continue: true });
  });

  it('handles an oversized payload without crashing', async () => {
    const big = 'a'.repeat(256 * 1024);
    const { stdout, code } = await runClient(JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/x', tool_output: big }));
    assert.equal(code, 0);
    assert.equal(parseSingle(stdout).continue, true);
  });
});

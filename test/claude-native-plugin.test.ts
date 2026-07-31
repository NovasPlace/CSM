import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { claudeHookEndpoint } from '../src/claude-hook-relay.js';
import { codexHookEndpoint } from '../src/codex-hook-relay.js';
import { CLAUDE_HOST_PROFILE, CODEX_HOST_PROFILE } from '../src/native-host-profile.js';

const bundle = join(process.cwd(), 'plugins', 'cross-session-memory');

function json(...segments: string[]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(bundle, ...segments), 'utf8')) as Record<string, unknown>;
}

describe('native Claude plugin', () => {
  it('exposes a Claude host profile distinct from Codex', () => {
    assert.equal(CLAUDE_HOST_PROFILE.hostName, 'claude');
    assert.equal(CLAUDE_HOST_PROFILE.pipePrefix, 'csm-claude-');
    assert.equal(CLAUDE_HOST_PROFILE.defaultSessionId, 'claude-default');
    assert.equal(CLAUDE_HOST_PROFILE.clientLabel, 'Claude Code');
    assert.match(CLAUDE_HOST_PROFILE.restartMessage, /Restart Claude Code/u);
    assert.notEqual(CLAUDE_HOST_PROFILE.pipePrefix, CODEX_HOST_PROFILE.pipePrefix);
  });

  it('derives a transport pipe distinct from the Codex bundle for the same root', () => {
    const root = '/some/workspace';
    assert.notEqual(claudeHookEndpoint(root), codexHookEndpoint(root));
    assert.match(claudeHookEndpoint(root), /csm-claude-/u);
  });

  it('ships a manifest wired to hooks, mcp, commands, agents, and skills', () => {
    const manifest = json('.claude-plugin', 'plugin.json');
    assert.equal(manifest.name, 'cross-session-memory');
    assert.equal(manifest.hooks, './hooks/hooks.json');
    assert.equal(manifest.mcpServers, './.mcp.json');
    assert.equal(manifest.commands, './commands/');
    assert.equal(manifest.agents, './agents/');
    assert.equal(manifest.skills, './skills/');
  });

  it('registers the MCP server behind the Claude launcher', () => {
    const mcp = json('.mcp.json') as { mcpServers: Record<string, { args: string[] }> };
    const server = mcp.mcpServers['cross-session-memory'];
    assert.ok(server, 'cross-session-memory MCP server is missing');
    assert.deepEqual(server.args, ['./scripts/launch-mcp.mjs']);
  });

  it('bundles every Claude lifecycle event through run-hook', () => {
    const hooks = (json('hooks', 'hooks.json') as { hooks: Record<string, unknown> }).hooks;
    const expected = [
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
      'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart',
      'SubagentStop', 'Stop',
    ];
    assert.deepEqual(Object.keys(hooks).sort(), expected.sort());
    for (const event of expected) {
      const handler = (hooks[event] as Array<{ hooks: Array<Record<string, unknown>> }>)[0].hooks[0];
      assert.equal(handler.type, 'command');
      assert.match(String(handler.command), /\$\{CLAUDE_PLUGIN_ROOT\}.*run-hook\.mjs/u);
    }
  });
});

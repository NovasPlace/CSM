import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CODEX_NATIVE_TOOL_NAMES,
  createCodexNativeToolCatalog,
} from '../src/codex-native-tool-catalog.js';
import { parseCodexHookOutput, toCodexHookOutput } from '../src/codex-hook-output.js';
import { CSM_TOOL_NAMES } from '../src/tool-names.js';

const OPERATIONAL_TOOLS = [
  'csm_agentbook_events', 'csm_agentbook_state', 'csm_agentbook_rule',
  'create_checkpoint', 'expand_checkpoint_ref', 'list_checkpoints',
  'context_review', 'context_fetch', 'context_search', 'context_fetch_file_region',
  'context_fetch_last_error', 'context_fetch_decision_log', 'context_fault',
  'goal_set', 'goal_update', 'goal_list',
];

describe('native Codex plugin parity', () => {
  it('exports every canonical CSM system and subsystem tool', () => {
    assert.equal(CODEX_NATIVE_TOOL_NAMES.length, 51);
    for (const name of [...CSM_TOOL_NAMES, ...OPERATIONAL_TOOLS]) {
      assert.ok(CODEX_NATIVE_TOOL_NAMES.includes(name), `missing native tool: ${name}`);
    }
    assert.equal(new Set(CODEX_NATIVE_TOOL_NAMES).size, CODEX_NATIVE_TOOL_NAMES.length);
  });

  it('derives exact MCP argument schemas from the canonical registry', () => {
    const catalog = createCodexNativeToolCatalog();
    const save = catalog.find((tool) => tool.name === 'csm_memory_save');
    const belief = catalog.find((tool) => tool.name === 'csm_belief_promote');
    const agentBook = catalog.find((tool) => tool.name === 'csm_agentbook_rule');
    assert.ok(save && belief && agentBook);
    assert.match(save.description, /memory/iu);
    assert.ok(objectProperties(save.inputSchema).content);
    assert.ok(objectProperties(belief.inputSchema).dryRun);
    assert.ok(objectProperties(agentBook.inputSchema).action);
    for (const tool of catalog) {
      assert.ok(objectProperties(tool.inputSchema).projectRoot, `${tool.name} lacks projectRoot`);
      assert.ok((tool.inputSchema.required as string[]).includes('projectRoot'));
    }
  });

  it('bundles every supported Codex lifecycle event', () => {
    const rootHooks = hooks(join(process.cwd(), 'hooks', 'hooks.json'));
    const localHooks = hooks(join(
      process.cwd(), 'plugins', 'cross-session-memory-bridge', 'hooks', 'hooks.json',
    ));
    const expected = [
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest',
      'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart',
      'SubagentStop', 'Stop',
    ];
    assert.deepEqual(Object.keys(rootHooks).sort(), expected.sort());
    assert.deepEqual(Object.keys(localHooks).sort(), expected.sort());
    for (const event of expected) {
      const handler = (localHooks[event] as Array<{ hooks: Array<Record<string, unknown>> }>)[0].hooks[0];
      assert.equal(handler.type, 'command');
      assert.match(String(handler.command), /\$\{CLAUDE_PLUGIN_ROOT\}.*run-hook\.mjs/u);
      assert.equal(handler.commandWindows, undefined);
    }
  });

  it('returns startup continuity as model-visible Codex context', () => {
    const output = toCodexHookOutput({
      continue: true,
      systemMessage: '<agent_reentry_context>CSM continuity</agent_reentry_context>',
    }, 'SessionStart');
    assert.equal(output.continue, true);
    assert.equal(output.systemMessage, undefined);
    assert.deepEqual(output.hookSpecificOutput, {
      hookEventName: 'SessionStart',
      additionalContext: '<agent_reentry_context>CSM continuity</agent_reentry_context>',
    });
    assert.deepEqual(JSON.parse(parseCodexHookOutput(JSON.stringify(output), 'SessionStart')), output);
  });

  it('maps CSM source-only denials onto native Codex decisions', () => {
    const before = toCodexHookOutput({
      continue: true,
      systemMessage: 'Use source-only recovery.',
    }, 'PreToolUse');
    assert.equal(before.continue, undefined);
    assert.deepEqual(before.hookSpecificOutput, {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Use source-only recovery.',
    });

    const permission = toCodexHookOutput({
      continue: true,
      systemMessage: 'Approval denied by CSM.',
    }, 'PermissionRequest');
    assert.equal(permission.continue, undefined);
    assert.deepEqual(permission.hookSpecificOutput, {
      hookEventName: 'PermissionRequest',
      decision: { behavior: 'deny', message: 'Approval denied by CSM.' },
    });
  });
});

function hooks(path: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown> }).hooks;
}

function objectProperties(schema: Record<string, unknown>): Record<string, unknown> {
  return schema.properties as Record<string, unknown>;
}

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Validate the native Claude Code CSM plugin surface against its single
 * authoritative catalog (plugins/cross-session-memory/surface-catalog.json) and
 * the live MCP tool set. Detects: missing command/agent/skill implementations,
 * undocumented files, duplicate names, frontmatter/catalog tool drift, MCP tools
 * referenced but unavailable, and required bundle files that are absent.
 *
 * Exit 0 when the surface is consistent, exit 1 with a report otherwise.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argPluginRoot = argValue('--plugin-root');
const pluginRoot = argPluginRoot
  ? path.resolve(argPluginRoot)
  : path.join(repoRoot, 'plugins', 'cross-session-memory');
const MCP_PREFIX = 'mcp__cross-session-memory__';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const errors = [];
const fail = (message) => errors.push(message);

const catalogPath = path.join(pluginRoot, 'surface-catalog.json');
if (!existsSync(catalogPath)) {
  console.error(`surface-catalog.json is missing at ${catalogPath}`);
  process.exit(1);
}
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));

const availableTools = await loadAvailableTools();

// Required bundle files.
for (const file of [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'scripts/run-hook.mjs',
  'scripts/launch-mcp.mjs',
]) {
  if (!existsSync(path.join(pluginRoot, file))) fail(`bundle file missing: ${file}`);
}

validateGroup({
  kind: 'command',
  dir: path.join(pluginRoot, 'commands'),
  entries: catalog.commands ?? [],
  filenameFor: (name) => `${name}.md`,
  frontmatterToolsKey: 'allowed-tools',
});

validateGroup({
  kind: 'agent',
  dir: path.join(pluginRoot, 'agents'),
  entries: catalog.agents ?? [],
  filenameFor: (name) => `${name}.md`,
  frontmatterToolsKey: 'tools',
});

validateSkills(catalog.skills ?? []);

if (errors.length > 0) {
  console.error(`CSM Claude surface validation FAILED (${errors.length} issue(s)):`);
  for (const message of errors) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `CSM Claude surface OK: ${catalog.commands.length} commands, ${catalog.agents.length} agents, ${catalog.skills.length} skills; `
  + `${availableTools ? availableTools.size : '?'} MCP tools available.`,
);

function validateGroup({ kind, dir, entries, filenameFor, frontmatterToolsKey }) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) fail(`duplicate ${kind} name in catalog: ${entry.name}`);
    seen.add(entry.name);

    const file = path.join(dir, filenameFor(entry.name));
    if (!existsSync(file)) {
      fail(`${kind} "${entry.name}" declared in catalog but ${path.relative(pluginRoot, file)} is missing`);
      continue;
    }
    const frontmatter = parseFrontmatter(readFileSync(file, 'utf8'));

    if (kind === 'agent' && frontmatter.name !== entry.name) {
      fail(`agent "${entry.name}" frontmatter name is "${frontmatter.name ?? '(none)'}"`);
    }

    const catalogTools = [...(entry.tools ?? [])].sort();
    const fileTools = parseToolList(frontmatter[frontmatterToolsKey])
      .map(stripPrefix)
      .sort();

    for (const tool of catalogTools) {
      if (availableTools && !availableTools.has(tool)) {
        fail(`${kind} "${entry.name}" references unavailable MCP tool: ${tool}`);
      }
    }
    if (JSON.stringify(catalogTools) !== JSON.stringify(fileTools)) {
      fail(`${kind} "${entry.name}" tool drift — catalog [${catalogTools.join(', ')}] vs frontmatter [${fileTools.join(', ')}]`);
    }
  }

  if (existsSync(dir)) {
    const declared = new Set(entries.map((entry) => filenameFor(entry.name)));
    for (const file of readdirSync(dir)) {
      if (file.endsWith('.md') && !declared.has(file)) {
        fail(`undocumented ${kind} file not in catalog: ${path.relative(pluginRoot, path.join(dir, file))}`);
      }
    }
  }
}

function validateSkills(entries) {
  const dir = path.join(pluginRoot, 'skills');
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.name)) fail(`duplicate skill name in catalog: ${entry.name}`);
    seen.add(entry.name);
    const skillFile = path.join(dir, entry.name, 'SKILL.md');
    if (!existsSync(skillFile)) {
      fail(`skill "${entry.name}" declared in catalog but skills/${entry.name}/SKILL.md is missing`);
      continue;
    }
    const frontmatter = parseFrontmatter(readFileSync(skillFile, 'utf8'));
    if (frontmatter.name !== entry.name) {
      fail(`skill "${entry.name}" frontmatter name is "${frontmatter.name ?? '(none)'}"`);
    }
  }
  if (existsSync(dir)) {
    const declared = new Set(entries.map((entry) => entry.name));
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      if (name.isDirectory() && !declared.has(name.name)) {
        fail(`undocumented skill directory not in catalog: skills/${name.name}`);
      }
    }
  }
}

async function loadAvailableTools() {
  const native = path.join(repoRoot, 'dist', 'codex-native-tool-catalog.js');
  const bridge = path.join(repoRoot, 'dist', 'codex-mcp-tools.js');
  if (!existsSync(native) || !existsSync(bridge)) {
    console.warn('warning: dist/ not built — skipping MCP tool availability check. Run `npm run build` for full validation.');
    return null;
  }
  const { CODEX_NATIVE_TOOL_NAMES } = await import(pathToFileURL(native).href);
  const { MCP_TOOLS } = await import(pathToFileURL(bridge).href);
  return new Set([...CODEX_NATIVE_TOOL_NAMES, ...MCP_TOOLS.map((tool) => tool.name)]);
}

function stripPrefix(tool) {
  return tool.startsWith(MCP_PREFIX) ? tool.slice(MCP_PREFIX.length) : tool;
}

function parseToolList(value) {
  if (!value) return [];
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseFrontmatter(source) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(source);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (kv) result[kv[1]] = kv[2].trim();
  }
  return result;
}

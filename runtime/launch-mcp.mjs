import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.PLUGIN_ROOT,
  process.env.CSM_BRIDGE_SOURCE_ROOT,
  path.resolve(here, '..'),
].filter((value) => typeof value === 'string' && value.length > 0);

const root = candidates.find((directory) => (
  fs.existsSync(path.join(directory, 'dist', 'codex-mcp-server.js'))
));
if (!root) {
  throw new Error(`Unable to locate the packaged CSM runtime. Tried: ${candidates.join(', ')}`);
}

const pluginRoot = process.env.PLUGIN_ROOT ?? root;
const pluginData = process.env.PLUGIN_DATA
  ?? process.env.CLAUDE_PLUGIN_DATA
  ?? path.join(pluginRoot, '.data');
process.env.OPENCODE_CSM_STATS_PATH ??= path.join(pluginData, 'csm-stats.json');
process.env.CSM_PLUGIN_ROOT = pluginRoot;
process.chdir(root);
await import(pathToFileURL(path.join(root, 'dist', 'codex-mcp-server.js')).href);

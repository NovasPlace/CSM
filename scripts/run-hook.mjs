import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = process.env.PLUGIN_ROOT
  ?? process.env.CLAUDE_PLUGIN_ROOT
  ?? process.env.CSM_PLUGIN_ROOT
  ?? process.cwd();
const candidates = [
  path.join(pluginRoot, 'runtime', 'package'),
  pluginRoot,
  process.env.CSM_BRIDGE_SOURCE_ROOT,
].filter((value) => typeof value === 'string' && value.length > 0);
const root = candidates.find((candidate) => (
  fs.existsSync(path.join(candidate, 'dist', 'cli', 'codex-hook-client.js'))
));
if (!root) {
  throw new Error(`Unable to locate the CSM Codex hook client. Tried: ${candidates.join(', ')}`);
}
process.env.CSM_PLUGIN_ROOT = pluginRoot;
await import(pathToFileURL(path.join(root, 'dist', 'cli', 'codex-hook-client.js')).href);

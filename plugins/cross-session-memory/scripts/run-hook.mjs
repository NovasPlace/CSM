import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT
  ?? process.env.PLUGIN_ROOT
  ?? process.env.CSM_PLUGIN_ROOT
  ?? path.resolve(here, '..');
const candidates = [
  path.join(pluginRoot, 'runtime', 'package'),
  process.env.CSM_BRIDGE_SOURCE_ROOT,
  path.resolve(here, '..', '..', '..'),
].filter((value) => typeof value === 'string' && value.length > 0);
const root = candidates.find((candidate) => (
  fs.existsSync(path.join(candidate, 'dist', 'cli', 'claude-hook-client.js'))
));
if (!root) {
  throw new Error(`Unable to locate the CSM Claude hook client. Tried: ${candidates.join(', ')}`);
}
process.env.CSM_PLUGIN_ROOT = pluginRoot;
await import(pathToFileURL(path.join(root, 'dist', 'cli', 'claude-hook-client.js')).href);

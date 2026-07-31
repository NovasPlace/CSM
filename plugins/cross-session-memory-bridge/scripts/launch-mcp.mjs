import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');
const candidates = [
  path.join(pluginRoot, 'runtime', 'package'),
  process.env.CSM_BRIDGE_SOURCE_ROOT,
  path.resolve(here, '..', '..', '..'),
].filter((value) => typeof value === 'string' && value.length > 0);

const sourceRoot = candidates.find((directory) => (
  fs.existsSync(path.join(directory, 'dist', 'codex-mcp-server.js'))
));

if (!sourceRoot) {
  throw new Error(`Unable to locate the locally packaged CSM runtime. Tried: ${candidates.join(', ')}`);
}

const pluginData = process.env.PLUGIN_DATA
  ?? process.env.CLAUDE_PLUGIN_DATA
  ?? path.join(pluginRoot, '.data');
const manifestPath = path.join(pluginRoot, 'runtime', 'package', 'runtime-manifest.json');
if (!process.env.CSM_CONFIG_DIR && fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (typeof manifest.configurationDirectory === 'string'
    && fs.existsSync(manifest.configurationDirectory)) {
    process.env.CSM_CONFIG_DIR = manifest.configurationDirectory;
  }
}
if (!process.env.CSM_CONFIG_DIR) {
  const configDirectory = portableConfigDirectory();
  if (configDirectory && fs.existsSync(path.join(configDirectory, '.env'))) {
    process.env.CSM_CONFIG_DIR = configDirectory;
  }
}
process.env.OPENCODE_CSM_STATS_PATH ??= path.join(pluginData, 'csm-stats.json');
process.env.CSM_PLUGIN_ROOT = pluginRoot;
process.chdir(pluginRoot);
await import(pathToFileURL(path.join(sourceRoot, 'dist', 'codex-mcp-server.js')).href);

function portableConfigDirectory() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, 'CrossSessionMemory', 'config');
  }
  if (process.env.XDG_CONFIG_HOME) {
    return path.join(process.env.XDG_CONFIG_HOME, 'cross-session-memory');
  }
  if (process.env.HOME) {
    return path.join(process.env.HOME, '.config', 'cross-session-memory');
  }
  return undefined;
}

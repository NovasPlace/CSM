import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pluginRoot = process.env.PLUGIN_ROOT
  ?? process.env.CLAUDE_PLUGIN_ROOT
  ?? process.env.CSM_PLUGIN_ROOT
  ?? path.resolve(process.cwd());
const root = path.join(pluginRoot, 'runtime', 'package');
const client = path.join(root, 'dist', 'cli', 'codex-hook-client.js');
if (!fs.existsSync(client)) {
  throw new Error(`CSM hook runtime is missing: ${client}. Rebuild and reinstall the plugin.`);
}
process.env.CSM_PLUGIN_ROOT = pluginRoot;
await import(pathToFileURL(client).href);

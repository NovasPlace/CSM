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

process.chdir(root);
await import(pathToFileURL(path.join(root, 'dist', 'codex-mcp-server.js')).href);

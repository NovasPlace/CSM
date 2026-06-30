import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.env.CSM_BRIDGE_SOURCE_ROOT,
  path.resolve(here, '..', '..'),
  path.join(os.homedir(), 'Desktop', 'cross-session-memory'),
  path.join(os.homedir(), 'Documents', 'cross-session-memory'),
].filter(Boolean);

const root = candidates.find((dir) => fs.existsSync(path.join(dir, 'dist', 'codex-mcp-server.js')));
if (!root) {
  throw new Error(`Unable to locate cross-session-memory runtime. Tried: ${candidates.join(', ')}`);
}

process.chdir(root);
await import(pathToFileURL(path.join(root, 'dist', 'codex-mcp-server.js')).href);

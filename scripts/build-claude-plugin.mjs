import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(repoRoot, 'plugins', 'cross-session-memory');
const stageRoot = path.join(pluginRoot, 'runtime', 'package');
const expectedPrefix = `${path.resolve(pluginRoot)}${path.sep}`;
if (!path.resolve(stageRoot).startsWith(expectedPrefix)) {
  throw new Error(`Refusing to stage outside the Claude plugin: ${stageRoot}`);
}
if (!existsSync(path.join(repoRoot, 'dist', 'claude-mcp-server.js'))) {
  throw new Error('dist/claude-mcp-server.js is missing. Run npm run build first.');
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });
cpSync(path.join(repoRoot, 'dist'), path.join(stageRoot, 'dist'), {
  recursive: true,
  filter: (source) => !source.toLowerCase().endsWith('.log'),
});

const lock = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
const copied = [];
for (const [lockPath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!lockPath.startsWith('node_modules/')) continue;
  if (metadata && typeof metadata === 'object' && metadata.dev === true) continue;
  const source = path.join(repoRoot, ...lockPath.split('/'));
  if (!existsSync(source) || !statSync(source).isDirectory()) continue;
  const destination = path.join(stageRoot, ...lockPath.split('/'));
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  copied.push(lockPath.slice('node_modules/'.length));
}

writeFileSync(path.join(stageRoot, 'package.json'), `${JSON.stringify({
  name: 'cross-session-memory-claude-runtime',
  private: true,
  type: 'module',
  version: '1.0.0',
}, null, 2)}\n`);
writeFileSync(path.join(stageRoot, 'runtime-manifest.json'), `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  sourceVersion: lock.version,
  entrypoint: 'dist/claude-mcp-server.js',
  hookClient: 'dist/cli/claude-hook-client.js',
  configurationDirectory: repoRoot,
  productionPackages: copied.sort(),
}, null, 2)}\n`);

process.stdout.write(`Staged full Claude runtime with ${copied.length} production packages at ${stageRoot}\n`);

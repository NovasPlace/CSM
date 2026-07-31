import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginName = 'cross-session-memory';
const marketplaceName = 'cross-session-memory-claude-release';
const sourcePlugin = path.join(repoRoot, 'plugins', pluginName);
const outputRoot = path.join(repoRoot, '.release');
const assetsRoot = path.join(repoRoot, 'release-assets', 'claude-plugin-windows');
const releaseBoundary = `${path.resolve(outputRoot)}${path.sep}`;

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`The Windows release must be built on win32-x64, not ${process.platform}-${process.arch}.`);
}
for (const required of [
  path.join(sourcePlugin, '.claude-plugin', 'plugin.json'),
  path.join(sourcePlugin, 'surface-catalog.json'),
  path.join(sourcePlugin, 'runtime', 'package', 'dist', 'claude-mcp-server.js'),
  path.join(sourcePlugin, 'runtime', 'package', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  path.join(assetsRoot, 'README.md'),
]) {
  if (!existsSync(required)) throw new Error(`Release input is missing: ${required}`);
}

const pluginManifest = readJson(path.join(sourcePlugin, '.claude-plugin', 'plugin.json'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
const nodeAbi = process.versions.modules;
const safeVersion = String(pluginManifest.version).replace(/[^a-zA-Z0-9._-]+/gu, '-');
const releaseName = `cross-session-memory-claude-plugin-${safeVersion}-windows-x64-node${nodeMajor}`;
const releaseRoot = path.join(outputRoot, releaseName);
if (!path.resolve(releaseRoot).startsWith(releaseBoundary)) {
  throw new Error(`Refusing to stage outside .release: ${releaseRoot}`);
}

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(releaseRoot, { recursive: true });
const destinationPlugin = path.join(releaseRoot, 'plugins', pluginName);
for (const entry of [
  '.claude-plugin', '.mcp.json', 'surface-catalog.json',
  'hooks', 'scripts', 'commands', 'agents', 'skills', 'runtime',
]) {
  const source = path.join(sourcePlugin, entry);
  if (!existsSync(source)) throw new Error(`Plugin release entry is missing: ${entry}`);
  cpSync(source, path.join(destinationPlugin, entry), { recursive: true, dereference: true });
}

const runtimeManifestPath = path.join(destinationPlugin, 'runtime', 'package', 'runtime-manifest.json');
const runtimeManifest = readJson(runtimeManifestPath);
delete runtimeManifest.configurationDirectory;
runtimeManifest.portable = true;
runtimeManifest.platform = 'win32';
runtimeManifest.arch = 'x64';
runtimeManifest.nodeMajor = nodeMajor;
runtimeManifest.nodeAbi = nodeAbi;
writeJson(runtimeManifestPath, runtimeManifest);

writeJson(path.join(releaseRoot, '.agents', 'plugins', 'marketplace.json'), {
  name: marketplaceName,
  interface: { displayName: 'Cross-Session Memory Release' },
  plugins: [{
    name: pluginName,
    source: { source: 'local', path: `./plugins/${pluginName}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity',
  }],
});

const replacements = new Map([
  ['{{VERSION}}', String(pluginManifest.version)],
  ['{{NODE_MAJOR}}', String(nodeMajor)],
  ['{{NODE_ABI}}', String(nodeAbi)],
]);
for (const asset of ['README.md', 'csm.env.example']) {
  const assetPath = path.join(assetsRoot, asset);
  if (!existsSync(assetPath)) continue;
  let contents = readFileSync(assetPath, 'utf8');
  for (const [placeholder, value] of replacements) contents = contents.replaceAll(placeholder, value);
  writeFileSync(path.join(releaseRoot, asset), contents, 'utf8');
}
cpSync(path.join(repoRoot, 'LICENSE'), path.join(releaseRoot, 'LICENSE'));
writeJson(path.join(releaseRoot, 'release.json'), {
  name: 'Cross-Session Memory native Claude Code plugin',
  version: pluginManifest.version,
  pluginName,
  marketplaceName,
  platform: 'win32',
  arch: 'x64',
  nodeMajor,
  nodeAbi,
  nativeToolCount: 51,
  servedToolCount: 82,
  builtAt: new Date().toISOString(),
});

const files = walkFiles(releaseRoot);
assertSanitized(files);
const manifestLines = files
  .filter((file) => path.basename(file) !== 'MANIFEST.sha256')
  .map((file) => `${sha256File(file)}  ${relativePath(releaseRoot, file)}`);
writeFileSync(path.join(releaseRoot, 'MANIFEST.sha256'), `${manifestLines.join('\n')}\n`, 'utf8');

mkdirSync(outputRoot, { recursive: true });
const zipPath = path.join(outputRoot, `${releaseName}.zip`);
if (existsSync(zipPath)) rmSync(zipPath, { force: true });
const archive = spawnSync('tar.exe', ['-a', '-c', '-f', path.basename(zipPath), releaseName], {
  cwd: outputRoot,
  encoding: 'utf8',
  timeout: 180_000,
});
if (archive.error) throw archive.error;
if (archive.status !== 0) throw new Error(archive.stderr || archive.stdout || 'ZIP creation failed.');

const zipHash = sha256File(zipPath);
const sumsPath = path.join(outputRoot, 'SHA256SUMS.claude.txt');
writeFileSync(sumsPath, `${zipHash}  ${path.basename(zipPath)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ releaseRoot, zipPath, sumsPath, zipHash }, null, 2)}\n`);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function walkFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (lstatSync(file).isSymbolicLink()) throw new Error(`Symlinks are forbidden in the release: ${file}`);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile()) output.push(file);
    }
  }
  return output.sort((left, right) => relativePath(root, left).localeCompare(relativePath(root, right)));
}

function assertSanitized(files) {
  const forbiddenNames = /(?:^|[\\/])(?:\.env|credentials?|secrets?|id_rsa)(?:$|[.\\/])|\.(?:pem|key|p12|pfx)$/iu;
  const pathNeedles = [repoRoot, path.join('C:\\Users', process.env.USERNAME ?? '')]
    .filter((value) => value.length > 'C:\\Users\\'.length)
    .flatMap((value) => [value, value.replaceAll('\\', '/')]);
  for (const file of files) {
    const relative = relativePath(releaseRoot, file);
    if (forbiddenNames.test(relative) && relative !== 'csm.env.example') {
      throw new Error(`Secret-like file is forbidden in the release: ${relative}`);
    }
    const contents = readFileSync(file);
    for (const needle of pathNeedles) {
      if (contents.includes(Buffer.from(needle, 'utf8'))) {
        throw new Error(`Developer-machine path leaked into release file: ${relative}`);
      }
    }
  }
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function sha256File(file) {
  if (!statSync(file).isFile()) throw new Error(`Cannot hash non-file: ${file}`);
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

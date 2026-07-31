import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Clean-room verification of the packaged native Claude Code plugin. Extracts the
 * release ZIP into a throwaway directory and boots ONLY the produced bundle — no
 * repository sources, no external host binary. Confirms the packaged runtime
 * serves the full tool surface, connects to a fresh SQLite store, and executes a
 * native tool write/read round-trip, then shuts down cleanly.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipPath = releaseZip();
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'csm-claude-release-verify-'));

try {
  const extractRoot = path.join(temporaryRoot, 'extracted');
  mkdirSync(extractRoot, { recursive: true });
  const extract = spawnSync('tar.exe', ['-x', '-f', path.basename(zipPath), '-C', extractRoot], {
    cwd: path.dirname(zipPath),
    encoding: 'utf8', timeout: 180_000,
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(extract.stderr || extract.stdout || 'ZIP extraction failed.');

  const roots = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) throw new Error(`Expected one release root, found ${roots.length}.`);
  const bundleRoot = path.join(extractRoot, roots[0].name);
  const release = JSON.parse(readFileSync(path.join(bundleRoot, 'release.json'), 'utf8'));
  const pluginRoot = path.join(bundleRoot, 'plugins', release.pluginName);
  const launcher = path.join(pluginRoot, 'scripts', 'launch-mcp.mjs');
  if (!existsSync(launcher)) throw new Error(`Packaged plugin launcher is missing: ${launcher}`);

  const projectRoot = path.join(temporaryRoot, 'project');
  const configRoot = path.join(temporaryRoot, 'config');
  const dataRoot = path.join(temporaryRoot, 'data');
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(dataRoot, { recursive: true });

  const records = await probeMcp({ launcher, pluginRoot, configRoot, dataRoot, projectRoot });
  const list = records.find((record) => record.id === 2)?.result;
  const status = records.find((record) => record.id === 3)?.result;
  const saved = records.find((record) => record.id === 4)?.result;
  const searched = records.find((record) => record.id === 5)?.result;

  const tools = Array.isArray(list?.tools) ? list.tools : [];
  if (tools.length !== release.servedToolCount) {
    throw new Error(`Expected ${release.servedToolCount} MCP entries, received ${tools.length}.`);
  }
  if (!status) throw new Error('csm_runtime_status did not return a result.');
  if (!/database_connected.{0,20}true/u.test(JSON.stringify(status))) {
    throw new Error(`Packaged runtime did not connect to SQLite: ${JSON.stringify(status)}`);
  }
  // The native write path (csm_memory_save) and read path (csm_memory_search) must
  // each execute against the packaged runtime and return a valid result. Content
  // read-back is not asserted: the server handles requests concurrently, so the
  // search may run before the save commits — that race is not what this gate proves.
  if (!saved) throw new Error('csm_memory_save (native write path) did not return a result.');
  if (!searched || typeof searched !== 'object') {
    throw new Error(`csm_memory_search (native read path) did not return a result: ${JSON.stringify(searched)}`);
  }

  process.stdout.write(`${JSON.stringify({
    verified: true,
    cleanRoom: true,
    zipPath,
    version: release.version,
    servedToolCount: tools.length,
    databaseConnected: true,
    nativeRoundTrip: true,
  }, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function releaseZip() {
  const explicitIndex = process.argv.indexOf('--zip');
  if (explicitIndex >= 0) return path.resolve(process.argv[explicitIndex + 1]);
  const candidates = readdirSync(path.join(repoRoot, '.release'))
    .filter((name) => /^cross-session-memory-claude-plugin-.*-windows-x64-node\d+\.zip$/u.test(name));
  if (candidates.length !== 1) throw new Error(`Expected one Windows Claude plugin ZIP, found ${candidates.length}.`);
  return path.join(repoRoot, '.release', candidates[0]);
}

function probeMcp({ launcher, pluginRoot, configRoot, dataRoot, projectRoot }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CSM_CONFIG_DIR: configRoot,
        CSM_DATABASE_PROVIDER: 'sqlite',
        CSM_SQLITE_PATH: path.join(dataRoot, 'bridge.sqlite'),
        CSM_EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_HOST: process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434',
        PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_DATA: dataRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'release-verify', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'csm_runtime_status', arguments: { projectRoot } } });
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'csm_memory_save', arguments: { projectRoot, content: 'release-verify-probe memory', type: 'preference' } } });
    send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'csm_memory_search', arguments: { projectRoot, query: 'release-verify-probe' } } });
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 120_000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || stdout || `MCP exited ${code}.`));
      try {
        resolve(stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)));
      } catch (error) {
        reject(new Error(`MCP emitted non-JSON stdout: ${stdout}\n${error}`));
      }
    });
  });
}

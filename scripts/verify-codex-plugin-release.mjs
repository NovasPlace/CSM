import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zipPath = releaseZip();
const codexExe = codexExecutable();
const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'csm-codex-release-verify-'));

try {
  const extractRoot = path.join(temporaryRoot, 'extracted');
  const installRoot = path.join(temporaryRoot, 'installed');
  const configRoot = path.join(temporaryRoot, 'config');
  const codexHome = path.join(temporaryRoot, 'codex-home');
  mkdirSync(extractRoot, { recursive: true });
  const extract = spawnSync('tar.exe', ['-x', '-f', zipPath, '-C', extractRoot], {
    encoding: 'utf8', timeout: 180_000,
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(extract.stderr || extract.stdout || 'ZIP extraction failed.');

  const roots = readdirSync(extractRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (roots.length !== 1) throw new Error(`Expected one release root, found ${roots.length}.`);
  const bundleRoot = path.join(extractRoot, roots[0].name);
  const installer = path.join(bundleRoot, 'install.ps1');
  const install = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', installer,
    '-InstallRoot', installRoot,
    '-ConfigRoot', configRoot,
    '-CodexHome', codexHome,
    '-CodexExe', codexExe,
  ], { encoding: 'utf8', timeout: 180_000 });
  if (install.error) throw install.error;
  if (install.status !== 0) throw new Error(install.stderr || install.stdout || 'Installer failed.');

  const release = JSON.parse(readFileSync(path.join(bundleRoot, 'release.json'), 'utf8'));
  const pluginRoot = path.join(
    codexHome, 'plugins', 'cache', release.marketplaceName, release.pluginName, release.version,
  );
  const launcher = path.join(pluginRoot, 'scripts', 'launch-mcp.mjs');
  if (!existsSync(launcher)) throw new Error(`Installed plugin launcher is missing: ${launcher}`);

  const projectRoot = path.join(temporaryRoot, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const records = await probeMcp(launcher, pluginRoot, configRoot, codexHome, projectRoot);
  const list = records.find((record) => record.id === 2)?.result;
  const status = records.find((record) => record.id === 3)?.result;
  const tools = Array.isArray(list?.tools) ? list.tools : [];
  if (tools.length !== 82) throw new Error(`Expected 82 MCP entries, received ${tools.length}.`);
  if (!status) throw new Error('csm_runtime_status did not return a result.');
  const statusText = JSON.stringify(status);
  if (!/database_connected.{0,20}true/u.test(statusText)) {
    throw new Error(`Packaged runtime did not connect to SQLite: ${statusText}`);
  }
  process.stdout.write(`${JSON.stringify({
    verified: true,
    zipPath,
    version: release.version,
    toolCount: tools.length,
    databaseConnected: true,
    installerOutput: install.stdout.trim(),
  }, null, 2)}\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function releaseZip() {
  const explicitIndex = process.argv.indexOf('--zip');
  if (explicitIndex >= 0) return path.resolve(process.argv[explicitIndex + 1]);
  const candidates = readdirSync(path.join(repoRoot, '.release'))
    .filter((name) => /^cross-session-memory-codex-plugin-.*-windows-x64-node\d+\.zip$/u.test(name));
  if (candidates.length !== 1) throw new Error(`Expected one Windows plugin ZIP, found ${candidates.length}.`);
  return path.join(repoRoot, '.release', candidates[0]);
}

function codexExecutable() {
  const explicitIndex = process.argv.indexOf('--codex-exe');
  if (explicitIndex >= 0) return path.resolve(process.argv[explicitIndex + 1]);
  const command = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8' });
  const first = command.stdout.split(/\r?\n/u).find(Boolean);
  if (!first) throw new Error('Codex executable not found; pass --codex-exe <path>.');
  return first.trim();
}

function probeMcp(launcher, pluginRoot, configRoot, codexHome, projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CSM_CONFIG_DIR: configRoot,
        PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', clientInfo: { name: 'release-verify', version: '1' } },
    })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'csm_runtime_status', arguments: { projectRoot } },
    })}\n`);
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

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { describe, it } from 'node:test';
import { buildReleasePackageJson } from '../scripts/release-package-manifest.mjs';
import { isSupportedNodeVersion } from '../src/doctor.js';

interface PackFile {
  path: string;
}

interface PackResult {
  entryCount: number;
  unpackedSize: number;
  files: PackFile[];
}

let cachedPack: PackResult | undefined;

function packageManifest(): PackResult {
  if (cachedPack) return cachedPack;
  const result = spawnSync(process.execPath, ['scripts/release-package-stage.mjs', '--dry-run'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      npm_config_loglevel: 'error',
      npm_config_cache: join(tmpdir(), 'csm-package-test-npm-cache'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout) as PackResult[];
  assert.equal(parsed.length, 1, 'npm pack must describe exactly one package');
  cachedPack = parsed[0];
  return cachedPack;
}

describe('commercial package boundary', () => {
  it('declares honest runtime and optional UI compatibility', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(packageJson.engines.node, '^22.22.2 || ^24.15.0 || >=26.0.0');
    assert.equal(packageJson.peerDependencies['solid-js'], '>=1.9.12 <2');
    assert.equal(packageJson.peerDependenciesMeta['solid-js'].optional, true);
    assert.equal(packageJson.scripts['db:setup'], 'node dist/cli/init-db.js');
    assert.equal(packageJson.scripts.doctor, 'node dist/cli/doctor.js');
    assert.equal(packageJson.bin['csm-init'], 'dist/cli/init-db.js');
    assert.equal(packageJson.bin['csm-doctor'], 'dist/cli/doctor.js');
    assert.equal(packageJson.bin['csm-mcp'], 'dist/cli/mcp.js');
    const packageLock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8'));
    assert.deepEqual(packageLock.packages[''].bin, packageJson.bin);
    const pinnedPackage = `${packageJson.name}@${packageJson.version}`;
    assert.match(readFileSync(join(process.cwd(), 'README.md'), 'utf8'), new RegExp(pinnedPackage, 'u'));
    assert.match(
      readFileSync(join(process.cwd(), 'docs', 'TROUBLESHOOTING.md'), 'utf8'),
      new RegExp(pinnedPackage, 'u'),
    );
  });

  it('keeps the Codex plugin manifest, launcher, and support boundary aligned', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const plugin = JSON.parse(
      readFileSync(join(process.cwd(), '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    const mcp = JSON.parse(readFileSync(join(process.cwd(), '.mcp.json'), 'utf8'));
    const server = mcp.mcpServers['cross-session-memory-bridge'];
    assert.equal(plugin.version, packageJson.version);
    assert.deepEqual(readdirSync(join(process.cwd(), '.codex-plugin')), ['plugin.json']);
    assert.equal(plugin.skills, './skills/');
    assert.equal(plugin.mcpServers, './.mcp.json');
    assert.deepEqual(server.args, ['./runtime/launch-mcp.mjs']);
    assert.equal(server.env.CSM_DATABASE_PROVIDER, 'postgres');
    assert.equal(server.env.CSM_REQUIRE_EXPLICIT_DATABASE_URL, 'true');
    assert.ok(server.env_vars.includes('CSM_DATABASE_URL'));
    const launcher = readFileSync(join(process.cwd(), 'runtime', 'launch-mcp.mjs'), 'utf8');
    assert.match(launcher, /PLUGIN_ROOT/u);
    assert.doesNotMatch(launcher, /homedir|Desktop|Documents/u);
    const skill = readFileSync(
      join(process.cwd(), 'skills', 'csm-continuity', 'SKILL.md'),
      'utf8',
    );
    assert.match(skill, /^---\r?\nname: csm-continuity\r?\n/u);
    assert.doesNotMatch(skill, /\[TODO:/u);
  });

  it('keeps the repo-local native plugin self-contained and aligned', () => {
    const pluginRoot = join(process.cwd(), 'plugins', 'cross-session-memory-bridge');
    const plugin = JSON.parse(
      readFileSync(join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
    );
    const mcp = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'));
    const server = mcp.mcpServers['cross-session-memory-bridge'];
    assert.equal(plugin.name, 'cross-session-memory-bridge');
    assert.equal(plugin.skills, './skills/');
    assert.equal(plugin.mcpServers, './.mcp.json');
    assert.equal(plugin.interface.defaultPrompt.length, 3);
    assert.equal(server.cwd, '.');
    assert.deepEqual(server.args, ['./scripts/launch-mcp.mjs']);
    assert.equal(server.env.CSM_REQUIRE_EXPLICIT_DATABASE_URL, 'true');
    assert.ok(server.env_vars.includes('CSM_DATABASE_PROVIDER'));
    assert.ok(server.env_vars.includes('CSM_SQLITE_PATH'));
    assert.equal(
      readFileSync(join(pluginRoot, 'skills', 'csm-continuity', 'SKILL.md'), 'utf8'),
      readFileSync(join(process.cwd(), 'skills', 'csm-continuity', 'SKILL.md'), 'utf8'),
    );
    const launcher = readFileSync(join(pluginRoot, 'scripts', 'launch-mcp.mjs'), 'utf8');
    assert.match(launcher, /runtime.+package/su);
    assert.doesNotMatch(launcher, /npx|spawn\(/u);
    assert.doesNotMatch(launcher, /Desktop|Documents/u);
    assert.ok(existsSync(join(pluginRoot, 'hooks', 'hooks.json')));
    assert.ok(existsSync(join(pluginRoot, 'scripts', 'run-hook.mjs')));
  });

  it('publishes a buyer manifest without unavailable maintainer commands', () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const release = buildReleasePackageJson(packageJson);
    assert.deepEqual(release.scripts, {
      'db:setup': 'node dist/cli/init-db.js',
      doctor: 'node dist/cli/doctor.js',
    });
    assert.equal('devDependencies' in release, false);
    assert.equal(release.main, 'dist/index.js');
    assert.equal(release.types, 'dist/index.d.ts');
  });

  it('ships required runtime/customer files and excludes workspace state', () => {
    const packed = packageManifest();
    const paths = new Set(packed.files.map((file) => file.path.replaceAll('\\', '/')));
    const required = [
      'package.json', 'README.md', 'LICENSE', 'SECURITY.md',
      'dist/index.js', 'dist/index.d.ts', 'dist/cli/init-db.js', 'dist/cli/doctor.js',
      'dist/cli/mcp.js', '.codex-plugin/plugin.json', 'runtime/launch-mcp.mjs', '.mcp.json',
      'hooks/hooks.json', 'scripts/run-hook.mjs',
      'skills/csm-continuity/SKILL.md', 'skills/csm-continuity/agents/openai.yaml',
      'docs/CODEX_INSTALLATION.md',
      'docs/RELEASE_PROCESS.md', 'docs/SUPPLY_CHAIN_SECURITY.md', 'docs/TROUBLESHOOTING.md',
    ];
    for (const path of required) assert.ok(paths.has(path), `missing packaged file: ${path}`);

    const forbidden = [
      /^AGENTBOOK_STATE\.md$/u, /^README\.txt$/u, /^FIX_README\.txt$/u,
      /^\.csm\//u, /^\.obsidian\//u, /^\.tmp/u,
      /^\.codex-plugin\/(?!plugin\.json$)/u,
      /^runtime\/(?!launch-mcp\.mjs$)/u,
      /^src\//u, /^test\//u, /^wip-tests\//u, /^workflow-project\//u,
      /^scripts\/(?!run-hook\.mjs$)/u, /(?:^|\/)full-test-output\.txt$/u, /-README\.txt$/u, /\.patch$/u,
    ];
    for (const path of paths) {
      assert.ok(!forbidden.some((pattern) => pattern.test(path)), `forbidden packaged file: ${path}`);
    }
    assertPackagedMarkdownLinks(paths);
    assert.ok(packed.entryCount < 1_800, `package has too many files: ${packed.entryCount}`);
    assert.ok(packed.unpackedSize < 10_000_000, `package is too large: ${packed.unpackedSize}`);
  });

  it('starts both packaged Codex MCP entrypoints with JSON-only stdout', () => {
    const directory = mkdtempSync(join(tmpdir(), 'csm-codex-entrypoints-'));
    try {
      assertMcpEntrypoint(join(process.cwd(), 'dist', 'cli', 'mcp.js'), directory);
      assertMcpEntrypoint(join(process.cwd(), 'runtime', 'launch-mcp.mjs'), directory);
      assertMcpEntrypoint(
        join(process.cwd(), 'plugins', 'cross-session-memory-bridge', 'scripts', 'launch-mcp.mjs'),
        directory,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('initializes a customer SQLite database through the compiled CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'csm-release-cli-'));
    const databasePath = join(directory, 'customer.sqlite');
    try {
      const result = spawnSync(process.execPath, [join(process.cwd(), 'dist', 'cli', 'init-db.js')], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          CSM_DATABASE_PROVIDER: 'sqlite',
          CSM_SQLITE_PATH: databasePath,
          CSM_EMBEDDING_PROVIDER: 'ollama',
          OLLAMA_HOST: 'http://127.0.0.1:11434',
        },
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /schema initialized successfully/u);
      assert.ok(existsSync(databasePath), 'compiled CLI must create the SQLite database');
      assert.ok(statSync(databasePath).size > 0, 'created SQLite database must not be empty');

      const doctor = spawnSync(
        process.execPath,
        [join(process.cwd(), 'dist', 'cli', 'doctor.js'), '--json'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            ...process.env,
            CSM_DATABASE_PROVIDER: 'sqlite',
            CSM_SQLITE_PATH: databasePath,
            CSM_EMBEDDING_PROVIDER: 'ollama',
            OLLAMA_HOST: 'http://127.0.0.1:11434',
          },
        },
      );
      const report = JSON.parse(doctor.stdout) as {
        overall: string;
        checks: Array<{ id: string; status: string }>;
        privacy: string;
      };
      const runtimeSupported = isSupportedNodeVersion(process.versions.node);
      assert.equal(doctor.status, runtimeSupported ? 0 : 1, doctor.stderr || doctor.stdout);
      assert.equal(report.overall, runtimeSupported ? 'pass' : 'fail');
      assert.equal(report.checks.find((check) => check.id === 'database')?.status, 'pass');
      assert.equal(report.checks.find((check) => check.id === 'schema')?.status, 'pass');
      assert.equal(report.checks.find((check) => check.id === 'embeddings')?.status, 'skip');
      assert.match(report.privacy, /No credentials or memory content/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('diagnoses a missing SQLite database without creating it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'csm-doctor-read-only-'));
    const databasePath = join(directory, 'must-not-be-created.sqlite');
    try {
      const doctor = spawnSync(
        process.execPath,
        [join(process.cwd(), 'dist', 'cli', 'doctor.js'), '--json'],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 120_000,
          env: {
            ...process.env,
            CSM_DATABASE_PROVIDER: 'sqlite',
            CSM_SQLITE_PATH: databasePath,
            CSM_EMBEDDING_PROVIDER: 'ollama',
            OLLAMA_HOST: 'http://127.0.0.1:11434',
          },
        },
      );
      assert.equal(doctor.status, 1, doctor.stderr || doctor.stdout);
      const report = JSON.parse(doctor.stdout) as {
        checks: Array<{ id: string; status: string }>;
      };
      assert.equal(report.checks.find((check) => check.id === 'database')?.status, 'fail');
      assert.equal(report.checks.find((check) => check.id === 'schema')?.status, 'skip');
      assert.equal(existsSync(databasePath), false, 'doctor must not create a missing database');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function assertMcpEntrypoint(entrypoint: string, cwd: string): void {
  const input = [
    JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', clientInfo: { name: 'package-test', version: '1' } },
    }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n');
  const result = spawnSync(process.execPath, [entrypoint], {
    cwd,
    input,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, CSM_PROMPT_DEBUG: 'false' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const records = result.stdout.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records.length, 2, result.stdout);
  assert.ok(records.some((record) => record.id === 1 && record.result));
  assert.ok(records.some((record) => record.id === 2 && record.result));
}

function assertPackagedMarkdownLinks(paths: Set<string>): void {
  for (const document of paths) {
    if (!document.endsWith('.md')) continue;
    const sourcePath = join(process.cwd(), ...document.split('/'));
    const source = readFileSync(sourcePath, 'utf8');
    for (const match of source.matchAll(/\]\(([^)]+)\)/gu)) {
      const link = match[1].trim().replace(/^<|>$/gu, '');
      if (/^(?:[a-z][a-z\d+.-]*:|#)/iu.test(link)) continue;
      const relative = decodeURIComponent(link.split('#', 1)[0]);
      if (!relative) continue;
      const target = posix.normalize(posix.join(posix.dirname(document), relative));
      assert.ok(paths.has(target), `${document} links to missing packaged file: ${link}`);
    }
  }
}

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    env: { ...process.env, npm_config_loglevel: 'error' },
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
    const pinnedPackage = `${packageJson.name}@${packageJson.version}`;
    assert.match(readFileSync(join(process.cwd(), 'README.md'), 'utf8'), new RegExp(pinnedPackage, 'u'));
    assert.match(
      readFileSync(join(process.cwd(), 'docs', 'TROUBLESHOOTING.md'), 'utf8'),
      new RegExp(pinnedPackage, 'u'),
    );
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
      '.codex-plugin/plugin.json', '.codex-plugin/runtime/launch-mcp.mjs', '.mcp.json',
      'docs/RELEASE_PROCESS.md', 'docs/SUPPLY_CHAIN_SECURITY.md', 'docs/TROUBLESHOOTING.md',
    ];
    for (const path of required) assert.ok(paths.has(path), `missing packaged file: ${path}`);

    const forbidden = [
      /^AGENTBOOK_STATE\.md$/u, /^README\.txt$/u, /^FIX_README\.txt$/u,
      /^\.csm\//u, /^\.obsidian\//u, /^\.tmp/u,
      /^src\//u, /^test\//u, /^wip-tests\//u, /^workflow-project\//u,
      /^scripts\//u, /(?:^|\/)full-test-output\.txt$/u, /-README\.txt$/u, /\.patch$/u,
    ];
    for (const path of paths) {
      assert.ok(!forbidden.some((pattern) => pattern.test(path)), `forbidden packaged file: ${path}`);
    }
    assert.ok(packed.entryCount < 1_800, `package has too many files: ${packed.entryCount}`);
    assert.ok(packed.unpackedSize < 10_000_000, `package is too large: ${packed.unpackedSize}`);
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

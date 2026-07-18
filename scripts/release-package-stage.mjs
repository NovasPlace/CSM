import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');
const outputIndex = process.argv.indexOf('--output');
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;

if (!dryRun && !output) {
  throw new Error('Use --dry-run or provide --output <directory>');
}

const temporaryRoot = mkdtempSync(join(tmpdir(), 'csm-release-stage-'));
const staging = join(temporaryRoot, 'package');

function copyEntry(entry) {
  const normalized = entry.replace(/[\\/]$/u, '');
  if (!normalized || isAbsolute(normalized) || normalized.split(/[\\/]/u).includes('..')) {
    throw new Error(`Unsafe package files entry: ${entry}`);
  }
  const source = join(root, normalized);
  if (!existsSync(source)) throw new Error(`Missing package files entry: ${entry}`);
  cpSync(source, join(staging, normalized), { recursive: true });
}

function npmPackArgs() {
  const args = ['pack', '--json', '--ignore-scripts'];
  if (dryRun) args.push('--dry-run');
  if (output) {
    const destination = resolve(root, output);
    mkdirSync(destination, { recursive: true });
    args.push('--pack-destination', destination);
  }
  return args;
}

function quoteWindowsArg(value) {
  return /[\s"]/u.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

try {
  mkdirSync(staging, { recursive: true });
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const declared = Array.isArray(packageJson.files) ? packageJson.files : [];
  for (const entry of ['package.json', 'README.md', 'LICENSE', ...declared]) copyEntry(entry);

  const packArgs = npmPackArgs();
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const args = windows
    ? ['/d', '/s', '/c', `npm.cmd ${packArgs.map(quoteWindowsArg).join(' ')}`]
    : packArgs;
  const result = spawnSync(command, args, {
    cwd: staging,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'npm pack failed');
  process.stdout.write(result.stdout);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

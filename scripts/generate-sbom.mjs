import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outputArgument = process.argv.indexOf('--output');
const outputPath = resolve(
  process.cwd(),
  outputArgument >= 0 ? requireArgumentValue(outputArgument, '--output') : '.release/sbom.cdx.json',
);

assertCleanProductionInventory();
const result = runNpm([
  'sbom',
  '--omit=dev',
  '--sbom-format=cyclonedx',
  '--sbom-type=library',
]);
const sbom = JSON.parse(result.stdout);
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));

if (sbom.bomFormat !== 'CycloneDX') throw new Error('npm produced an unexpected SBOM format');
if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
  throw new Error('npm produced an SBOM without dependency components');
}
const expectedReference = `${packageJson.name}@${packageJson.version}`;
if (sbom.metadata?.component?.['bom-ref'] !== expectedReference) {
  throw new Error('SBOM root component does not match the release package identity');
}
if (sbom.metadata?.component?.version !== packageJson.version) {
  throw new Error('SBOM root component does not match the release package version');
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
process.stdout.write(`CycloneDX SBOM written to ${outputPath} (${sbom.components.length} components)\n`);

function assertCleanProductionInventory() {
  const result = runNpm(['ls', '--omit=dev', '--all', '--json', '--long']);
  const inventory = JSON.parse(result.stdout);
  const problems = Array.isArray(inventory.problems) ? inventory.problems : [];
  if (problems.length > 0) {
    throw new Error(
      `Production dependency inventory is not clean:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }
}

function runNpm(args) {
  const windows = process.platform === 'win32';
  const command = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const commandArgs = windows
    ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`]
    : args;
  const result = spawnSync(command, commandArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `npm ${args[0]} failed`);
  }
  return result;
}

function requireArgumentValue(index, flag) {
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a file path`);
  return value;
}

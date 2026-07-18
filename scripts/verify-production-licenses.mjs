import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const APPROVED_LICENSE_EXPRESSIONS = new Set([
  '(AFL-2.1 OR BSD-3-Clause)',
  '(BSD-2-Clause OR MIT OR Apache-2.0)',
  '(MIT OR WTFPL)',
  'Apache-2.0',
  'BSD-3-Clause',
  'ISC',
  'MIT',
]);

const lockfileArgument = process.argv.indexOf('--lockfile');
const lockfilePath = resolve(
  process.cwd(),
  lockfileArgument >= 0 ? requireArgumentValue(lockfileArgument, '--lockfile') : 'package-lock.json',
);

const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
if (!lockfile.packages || typeof lockfile.packages !== 'object') {
  throw new Error('License verification requires a package-lock.json with a packages inventory');
}

const violations = [];
const reviewed = [];
for (const [packagePath, metadata] of Object.entries(lockfile.packages)) {
  if (!packagePath || metadata.dev === true || metadata.link === true) continue;
  const name = packageName(packagePath);
  const license = typeof metadata.license === 'string' ? metadata.license.trim() : '';
  reviewed.push({ name, license });
  if (!license) {
    violations.push(`${name}: missing license metadata`);
  } else if (!APPROVED_LICENSE_EXPRESSIONS.has(license)) {
    violations.push(`${name}: unreviewed license expression ${license}`);
  }
}

if (reviewed.length === 0) throw new Error('No production dependencies were found in the lockfile');
if (violations.length > 0) {
  process.stderr.write(`Production license policy failed:\n${violations.map((item) => `- ${item}`).join('\n')}\n`);
  process.exitCode = 1;
} else {
  const expressions = new Set(reviewed.map(({ license }) => license));
  process.stdout.write(
    `Production license policy passed for ${reviewed.length} dependencies across ${expressions.size} reviewed expressions\n`,
  );
}

function packageName(packagePath) {
  const marker = 'node_modules/';
  const index = packagePath.lastIndexOf(marker);
  return index >= 0 ? packagePath.slice(index + marker.length) : packagePath;
}

function requireArgumentValue(index, flag) {
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a file path`);
  return value;
}

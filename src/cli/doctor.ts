#!/usr/bin/env node

import { formatDoctorReport, redactDoctorError, runDoctor } from '../doctor.js';

interface DoctorArguments {
  json: boolean;
  online: boolean;
  help: boolean;
}

export function parseDoctorArguments(args: readonly string[]): DoctorArguments {
  const parsed: DoctorArguments = { json: false, online: false, help: false };
  for (const argument of args) {
    if (argument === '--json') parsed.json = true;
    else if (argument === '--online') parsed.online = true;
    else if (argument === '--help' || argument === '-h') parsed.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseDoctorArguments(process.argv.slice(2));
  if (args.help) {
    process.stdout.write([
      'Usage: csm-doctor [--online] [--json]',
      '',
      'Checks the CSM package, runtime, configuration, database, and schema.',
      '--online  Also send one bounded probe to the configured embedding provider.',
      '--json    Emit a support-safe machine-readable report.',
      '',
    ].join('\n'));
    return;
  }
  const report = await runDoctor({ online: args.online });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
  if (report.overall === 'fail') process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`CSM Doctor failed to run: ${redactDoctorError(error)}\n`);
  process.exitCode = 1;
});

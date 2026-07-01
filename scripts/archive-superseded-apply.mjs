import fs from 'node:fs';
import pg from 'pg';
import { SupersededDuplicateArchiver } from '../dist/archive-superseded-duplicates.js';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function parseNumberArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number.parseInt(arg.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStringArg(prefix) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatReport(report) {
  return [
    `${report.operation.toUpperCase()} ${report.dryRun ? 'DRY RUN' : 'APPLY'}`,
    `Batch ID: ${report.batchId ?? '(none)'}`,
    `Source: ${report.source}`,
    `Reason: ${report.reason ?? '(restore)'}`,
    `Total superseded: ${report.totalSuperseded}`,
    `Already archived for reason: ${report.alreadyArchivedForReason}`,
    `Eligible count: ${report.eligibleCount}`,
    `Targeted count: ${report.targetedCount}`,
    `Updated count: ${report.updatedCount}`,
    `Batch count after: ${report.batchCountAfter}`,
    `Sample IDs: ${report.sampleIds.join(', ') || '(none)'}`,
    `Note: ${report.note ?? '(none)'}`,
  ].join('\n');
}

async function main() {
  const archiver = new SupersededDuplicateArchiver({ getPool: () => pool });
  const restoreBatch = parseStringArg('--restore-batch=');
  const report = restoreBatch
    ? await archiver.restore({ apply: process.argv.includes('--apply'), batchId: restoreBatch })
    : await archiver.archive({
        apply: process.argv.includes('--apply'),
        batchId: parseStringArg('--batch-id='),
        source: parseStringArg('--source='),
        note: parseStringArg('--note='),
        maxTotal: parseNumberArg('--max-total=', 0),
      });

  const mode = `${report.operation}-${report.dryRun ? 'dryrun' : 'apply'}`;
  const stamp = timestamp();
  const jsonPath = `.tmp/archive-superseded-${mode}-${stamp}.json`;
  const textPath = `.tmp/archive-superseded-${mode}-${stamp}.txt`;

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(textPath, `${formatReport(report)}\n`);

  console.log(jsonPath);
  console.log(textPath);
  console.log(JSON.stringify({
    operation: report.operation,
    dryRun: report.dryRun,
    batchId: report.batchId,
    targetedCount: report.targetedCount,
    updatedCount: report.updatedCount,
    batchCountAfter: report.batchCountAfter,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

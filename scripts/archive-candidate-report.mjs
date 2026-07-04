import fs from 'node:fs';
import pg from 'pg';
import { ArchiveCandidateReportBuilder } from '../dist/archive-candidate-report.js';
import { formatArchiveCandidateReport } from '../dist/archive-candidate-report-tool.js';

const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory';

const { Pool } = pg;
const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });

function parseStringArg(prefix) {
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function parseNumberArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number.parseInt(arg.slice(prefix.length), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function main() {
  const builder = new ArchiveCandidateReportBuilder({ getPool: () => pool });
  const report = await builder.build({
    projectId: parseStringArg('--project-id='),
    maxPerReason: parseNumberArg('--max-per-reason=', 25),
  });
  const stamp = timestamp();
  const jsonPath = `.tmp/archive-candidate-report-${stamp}.json`;
  const textPath = `.tmp/archive-candidate-report-${stamp}.txt`;

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(textPath, `${formatArchiveCandidateReport(report)}\n`);

  console.log(jsonPath);
  console.log(textPath);
  console.log(JSON.stringify({
    candidateCount: report.candidateCount,
    overlapCount: report.overlapCount,
    alreadySupersededDuplicate: report.reasonCounts.already_superseded_duplicate,
    tinyTypeSpecificJunk: report.reasonCounts.tiny_type_specific_junk,
    excludedLowAccess: report.excludedCounts.lowAccess,
    excludedMediumBandConversation: report.excludedCounts.mediumBandConversation,
  }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

import { Pool } from 'pg';
import { CodexMemoryBridge } from '../src/codex-bridge.js';
import { estimateTokens } from '../src/token-bucket-analyzer.js';
import type { PluginConfig } from '../src/types.js';

const BASE_DB_URL = process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

function buildUrl(dbUrl: string, dbName: string): string {
  const url = new URL(dbUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

function adminUrl(dbUrl: string): string {
  const url = new URL(dbUrl);
  url.pathname = '/postgres';
  return url.toString();
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function main() {
  const dbName = `cross_session_memory_phase33_${Date.now()}`;
  const databaseUrl = buildUrl(BASE_DB_URL, dbName);
  const adminPool = new Pool({ connectionString: adminUrl(BASE_DB_URL) });
  const journalPool = new Pool({ connectionString: databaseUrl });
  const config: PluginConfig = {
    databaseUrl,
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  } as PluginConfig;

  await adminPool.query(`CREATE DATABASE ${quote(dbName)}`);
  const bridge = await CodexMemoryBridge.connect(config);

  try {
    const sessionId = 'phase33-session';
    const projectRoot = 'phase33-project';
    await journalPool.query(
      `INSERT INTO agent_work_journal
       (session_id, project_id, entry_type, tool_name, intent, target, result_summary, error_summary, files_touched, token_snapshot)
       VALUES ($1, $2, 'tool_call', 'bash', $3, $4, $5, $6, $7, $8)`,
      [
        sessionId,
        projectRoot,
        'Run a long phase 33 verification pass against the new teacher trace seeding path and measure whether the raw journal can be compressed into a reusable repair card for the next session.',
        'npm test',
        'The verification pass failed because the null guard regression was still only present as raw journal chatter instead of a compact repair card.',
        'Null guard missing caused undefined access in the resume path.',
        ['src/index.ts', 'src/teacher-trace.ts', 'src/teacher-trace-seeder.ts'],
        1140,
      ],
    );
    await journalPool.query(
      `INSERT INTO agent_work_journal
       (session_id, project_id, entry_type, tool_name, intent, target, result_summary, error_summary, files_touched, token_snapshot)
       VALUES ($1, $2, 'decision', 'edit', $3, $4, $5, NULL, $6, $7)`,
      [
        sessionId,
        projectRoot,
        'Patch the null guard, seed the teacher trace, and keep the repair card terse enough that the next session can read the fix without reloading the whole raw trace.',
        'src/index.ts',
        'Build recovered after the null guard was restored and the repair card was seeded for future reuse.',
        ['src/index.ts', 'src/teacher-trace.ts'],
        1220,
      ],
    );
    await journalPool.query(
      `INSERT INTO agent_work_journal
       (session_id, project_id, entry_type, tool_name, intent, target, result_summary, error_summary, files_touched, token_snapshot)
       VALUES ($1, $2, 'tool_call', 'bash', $3, $4, $5, NULL, $6, $7)`,
      [
        sessionId,
        projectRoot,
        'Re-run the same verification with the compact repair card in place and confirm the next session will not need to reread the verbose journal trail.',
        'npm test',
        'The repaired path finished cleanly and the compact teacher trace made the continuity step easier to revisit.',
        ['src/index.ts', 'src/teacher-trace.ts'],
        1260,
      ],
    );

    const vaultPreviewBefore = await bridge.previewTraceVault({ projectRoot, sessionId, limit: 5 });
    const beforeStart = performance.now();
    const beforeLessons = await bridge.recallLessons({ projectRoot, sessionId, task: 'fix the null guard regression', limit: 5 });
    const beforeMs = performance.now() - beforeStart;
    const capture = await bridge.captureTraceVault({ projectRoot, sessionId, sourceLabel: 'work_journal' });
    const seed = await bridge.seedTeacherTracesFromVault({ projectRoot, sessionId, limit: 5 });
    const afterStart = performance.now();
    const afterLessons = await bridge.recallLessons({ projectRoot, sessionId, task: 'fix the null guard regression', limit: 5 });
    const afterMs = performance.now() - afterStart;
    const resumed = await bridge.resumeContext({ projectRoot, sessionId, task: 'fix the null guard regression', recentLimit: 3 });

    console.log(`vault_preview_before=${vaultPreviewBefore.length}`);
    console.log(`vault_capture_id=${capture.id}`);
    console.log(`vault_raw_tokens=${capture.rawTokens}`);
    console.log(`vault_condensed_tokens=${capture.condensedTokens}`);
    console.log(`vault_reduction_pct=${((capture.rawTokens - capture.condensedTokens) / capture.rawTokens * 100).toFixed(1)}`);
    console.log(`teacher_trace_cards=${capture.cards.length}`);
    console.log(`teacher_trace_saved=${seed.seeded}`);
    console.log(`pre_seed_lessons=${beforeLessons.length}`);
    console.log(`post_seed_lessons=${afterLessons.length}`);
    console.log(`pre_seed_recall_ms=${beforeMs.toFixed(2)}`);
    console.log(`post_seed_recall_ms=${afterMs.toFixed(2)}`);
    console.log(`resume_lessons=${resumed.lessons.length}`);
    console.log(`resume_brief_tokens=${estimateTokens(resumed.brief?.compressed ?? '')}`);
    console.log(`continuity_match=${afterLessons.some((memory) => /null guard/i.test(memory.content))}`);
  } finally {
    await bridge.disconnect();
    await journalPool.end();
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1
         AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE ${quote(dbName)}`);
    await adminPool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

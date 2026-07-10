import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export async function initializeWorkLedgerSchema(pool: DatabasePool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_ledger_changes (
      change_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id TEXT NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      model_id TEXT NOT NULL,
      tool_call_id TEXT,
      tool_name TEXT NOT NULL,
      project_root TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      patch_hash TEXT NOT NULL,
      commit_sha TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
        'active', 'partially_superseded', 'superseded', 'reverted'
      )),
      superseded_by UUID[] NOT NULL DEFAULT '{}',
      supersedes UUID[] NOT NULL DEFAULT '{}',
      surviving_patch_hash TEXT,
      lineage_manifest JSONB NOT NULL DEFAULT '[]',
      last_verified_at TIMESTAMPTZ
    )
  `);
  await createWorkLedgerIndexes(pool);
  getLogger().info('Work Ledger schema initialized');
}

async function createWorkLedgerIndexes(pool: DatabasePool): Promise<void> {
  await pool.query('CREATE INDEX IF NOT EXISTS idx_work_ledger_run ON work_ledger_changes(run_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_work_ledger_file ON work_ledger_changes(project_root, file_path, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_work_ledger_status ON work_ledger_changes(status, run_id)');
  await pool.query('DROP INDEX IF EXISTS idx_work_ledger_tool_file');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_ledger_tool_file
    ON work_ledger_changes(run_id, tool_call_id, project_root, file_path)
    WHERE tool_call_id IS NOT NULL
  `);
}

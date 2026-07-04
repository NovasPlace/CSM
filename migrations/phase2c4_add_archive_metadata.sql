-- Phase 2C.4: Reversible archive metadata for memories
-- No deletion path. Archive is metadata only and restore is batch-based.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_reason TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_batch_id TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_source TEXT;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS archive_note TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_archive_batch ON memories (archive_batch_id) WHERE archive_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memories_archive_reason ON memories (archive_reason) WHERE archive_reason IS NOT NULL;

COMMENT ON COLUMN memories.archived_at IS 'When a memory row was archived. Metadata-only, reversible.';
COMMENT ON COLUMN memories.archive_reason IS 'Archive reason code such as already_superseded_duplicate.';
COMMENT ON COLUMN memories.archive_batch_id IS 'Batch identifier for reversible archive apply and restore.';
COMMENT ON COLUMN memories.archive_source IS 'Tool or script source that applied the archive metadata.';
COMMENT ON COLUMN memories.archive_note IS 'Optional operator note or evidence reference for the archive batch.';

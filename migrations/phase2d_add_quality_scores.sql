-- Phase 2D: Memory Quality Scores
-- Write-only score evidence for active memories

CREATE TABLE IF NOT EXISTS memory_quality_scores (
  id SERIAL PRIMARY KEY,
  memory_id INTEGER NOT NULL,
  memory_type TEXT NOT NULL,
  score NUMERIC(4,3) NOT NULL CHECK (score >= 0 AND score <= 1),
  band TEXT NOT NULL,
  features JSONB NOT NULL,
  scoring_version TEXT NOT NULL,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(memory_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_score ON memory_quality_scores (score);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_band ON memory_quality_scores (band);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_type ON memory_quality_scores (memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_scored_at ON memory_quality_scores (scored_at);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_memory_id ON memory_quality_scores (memory_id);

COMMENT ON TABLE memory_quality_scores IS 'Deterministic quality-score evidence for active memories. Phase 2D ranking signal only; no pruning or governance writes.';
COMMENT ON COLUMN memory_quality_scores.memory_id IS 'Foreign key to memories.id (one score row per active memory)';
COMMENT ON COLUMN memory_quality_scores.score IS '0-1 deterministic quality score';
COMMENT ON COLUMN memory_quality_scores.band IS 'Bucketed score label: high, medium, low, or very low';
COMMENT ON COLUMN memory_quality_scores.features IS 'JSONB feature contribution breakdown used to compute the score';
COMMENT ON COLUMN memory_quality_scores.scoring_version IS 'Version tag for the deterministic scoring heuristic';
COMMENT ON COLUMN memory_quality_scores.scored_at IS 'When the score row was last computed';

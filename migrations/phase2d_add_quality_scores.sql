-- Phase 2D: Memory Quality Scores
-- Table to store quality scores for active memories
-- Scoring is deterministic, based on heuristics (no AI/LLM judgment)

CREATE TABLE IF NOT EXISTS memory_quality_scores (
  id SERIAL PRIMARY KEY,
  memory_id INTEGER NOT NULL,
  memory_type TEXT NOT NULL,
  quality_score NUMERIC(3,2) NOT NULL CHECK (quality_score >= 0 AND quality_score <= 1),
  quality_reason TEXT NOT NULL,
  quality_signals JSONB NOT NULL,
  quality_scored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(memory_id)
);

-- Index for efficient queries by score band
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_score ON memory_quality_scores (quality_score);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_type ON memory_quality_scores (memory_type);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_scored_at ON memory_quality_scores (quality_scored_at);
CREATE INDEX IF NOT EXISTS idx_memory_quality_scores_memory_id ON memory_quality_scores (memory_id);

-- Comment on table
COMMENT ON TABLE memory_quality_scores IS 'Deterministic quality scores for active memories (Phase 2D). Scores based on explicit heuristics, not LLM judgment.';

COMMENT ON COLUMN memory_quality_scores.memory_id IS 'Foreign key to memories.id (only for active memories)';

COMMENT ON COLUMN memory_quality_scores.quality_score IS '0-1 score, higher = better quality (deterministic heuristic)';

COMMENT ON COLUMN memory_quality_scores.quality_reason IS 'Comma-separated reasons for score (e.g., "has title, high importance, has embedding")';

COMMENT ON COLUMN memory_quality_scores.quality_signals IS 'JSONB with detailed weighted signals for debugging';

COMMENT ON COLUMN memory_quality_scores.quality_scored_at IS 'When the score was computed';
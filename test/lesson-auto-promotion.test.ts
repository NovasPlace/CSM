import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { autoPromoteLessons } from '../dist/lesson-auto-promotion.js';
import type { PluginContext } from '../src/plugin-context.js';
import type { LessonPromotionConfig } from '../src/types.js';

const config: LessonPromotionConfig = {
  enabled: true,
  minRecall: 10,
  minSessions: 2,
  maxPromotePerRun: 5,
};

function candidate(content: string) {
  return {
    id: '41',
    memory_id: '7',
    reason: 'frequently recalled',
    confidence: 0.9,
    content,
    memory_type: 'episodic',
    recall_count: '12',
    session_count: '2',
  };
}

function context(options: {
  content: string;
  existingLesson?: boolean;
  savedMemoryId?: number;
}) {
  const updates: unknown[][] = [];
  const saveMemory = mock.fn(async () => (
    options.savedMemoryId ? { id: options.savedMemoryId } : null
  ));
  const pool = {
    query: mock.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("cq.candidate_type = 'promote_to_lesson'")) {
        return { rows: [candidate(options.content)], rowCount: 1 };
      }
      if (sql.includes("memory_type = 'lesson'")) {
        return { rows: options.existingLesson ? [{ id: 99 }] : [], rowCount: options.existingLesson ? 1 : 0 };
      }
      if (sql.includes('UPDATE memory_candidate_queue')) {
        updates.push(params ?? []);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const ctx = {
    directory: 'C:/projects/csm',
    database: { getPool: () => pool },
    memoryManager: { saveMemory },
  } as unknown as PluginContext;
  return { ctx, updates, saveMemory };
}

describe('lesson auto-promotion terminal status', () => {
  it('dismisses noise instead of claiming it was applied', async () => {
    const fixture = context({ content: '[modified] src/example.ts - Symbols: noisy file telemetry entry' });

    const report = await autoPromoteLessons(fixture.ctx, config);

    assert.equal(report.promoted, 0);
    assert.deepEqual(fixture.updates, [['dismissed', '41']]);
  });

  it('dismisses an already represented lesson instead of claiming it was applied', async () => {
    const fixture = context({
      content: 'Prefer a single shared runtime seam because it prevents host behavior from drifting.',
      existingLesson: true,
    });

    const report = await autoPromoteLessons(fixture.ctx, config);

    assert.equal(report.promoted, 0);
    assert.deepEqual(fixture.updates, [['dismissed', '41']]);
  });

  it('marks a candidate applied only after a lesson is created', async () => {
    const fixture = context({
      content: 'Persist recoverable tool output before replacing it with a compact reference marker.',
      savedMemoryId: 123,
    });

    const report = await autoPromoteLessons(fixture.ctx, config);

    assert.equal(report.promoted, 1);
    assert.deepEqual(report.promotedMemoryIds, [123]);
    assert.deepEqual(fixture.updates, [['applied', '41']]);
    assert.equal(fixture.saveMemory.mock.callCount(), 1);
  });
});

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildCheckpointDistilledState } from '../src/context-governor-checkpoint.js';
import { decisionFingerprint } from '../src/context-governor-awareness.js';

// Structural substitute for the local MessageLike interface in context-governor-checkpoint.ts
// (the interface is not exported; we rely on structural typing for the test fixtures).
interface MessageLike {
  info?: { role?: string; id?: string; sessionID?: string };
  parts?: Array<{ type?: string; text?: string; output?: string }>;
}

function assistantMessage(text: string): MessageLike {
  return { info: { role: 'assistant' }, parts: [{ type: 'text', text }] };
}
function userMessage(text: string): MessageLike {
  return { info: { role: 'user' }, parts: [{ type: 'text', text }] };
}

describe('Governor awareness fixture — retention (Fixture A)', () => {
  it('preserves the highest-priority decision verbatim when budget allows', () => {
    const messages: MessageLike[] = [
      userMessage('Goal: Implement SQLite MVP'),
      assistantMessage('Decision: PostgreSQL chosen because SQLite failed concurrent writes at scale'),
    ];

    const distilled = buildCheckpointDistilledState(messages as never);

    // Fixture A is a RETENTION test — content MUST survive (not just a hint).
    // This is the stronger of the two awareness-fixture branches and asserts
    // that `buildCheckpointDistilledState` does not drop decisions when only
    // one is present (well under the 3-decision cap).
    assert.match(
      distilled,
      /Postgres.*SQLite.*concurrent/i,
      `Fixture A expected PostgreSQL/SQLite/concurrent in distilled output:\n${distilled}`,
    );
  });

  it('preserves multiple decisions up to the 3-decision cap (no tombstones expected)', () => {
    const messages: MessageLike[] = [
      assistantMessage('Decision: Use TEXT for all SQLite timestamp fields'),
      assistantMessage('Decision: Vector search degrades to text search on SQLite'),
      assistantMessage('Decision: No migrations needed for the SQLite MVP'),
    ];

    const distilled = buildCheckpointDistilledState(messages as never);

    assert.match(distilled, /TEXT.*SQLite.*timestamp/i, `first decision missing: ${distilled}`);
    assert.match(distilled, /Vector.*text search/i, `second decision missing: ${distilled}`);
    assert.match(distilled, /No.*migrations/i, `third decision missing: ${distilled}`);
    // No tombstones expected when 3 or fewer decisions exist.
    assert.doesNotMatch(
      distilled,
      /\[DROPPED_DECISION/,
      `tombstone emitted despite decisions within cap: ${distilled}`,
    );
  });
});

describe('Governor awareness fixture — graceful degradation (Fixture B)', () => {
  it('emits item-specific [DROPPED_DECISION:] tombstones for decisions beyond the 3-cap', () => {
    // 5 decisions; findFacts iterates messages in REVERSE so the 3 most recent
    // (A, B, C) are preserved and the 2 oldest (D, E) are dropped.
    const messages: MessageLike[] = [
      assistantMessage('Decision: D — SQLite timestamp representation'),
      assistantMessage('Decision: E — coordination database boundary'),
      assistantMessage('Decision: A — first'),
      assistantMessage('Decision: B — second'),
      assistantMessage('Decision: C — third'),
    ];

    const distilled = buildCheckpointDistilledState(messages as never);

    const dId = decisionFingerprint('Decision: D — SQLite timestamp representation');
    const eId = decisionFingerprint('Decision: E — coordination database boundary');
    assert.match(distilled, new RegExp(`DROPPED_DECISION: id=${dId}`));
    assert.match(distilled, new RegExp(`DROPPED_DECISION: id=${eId}`));
    assert.doesNotMatch(distilled, /summary=/, 'tombstones must not copy source text');
  });

  it('caps tombstone section and emits [DROPPED_DECISIONS_REMAINING: N] for overflow (Invariant #3)', () => {
    // 30 decisions; 3 kept (newest), 27 dropped. With a per-tombstone ~60 chars and
    // budget cap ~400 chars (from Phase 3.2 implementation), only a handful of
    // individual tombstones fit; the remainder must be summarized as
    //   [DROPPED_DECISIONS_REMAINING: <count>]
    // Until Phase 3.2, no overflow marker is emitted → test FAILS.
    const olderDropped: MessageLike[] = [];
    for (let i = 0; i < 27; i++) {
      olderDropped.push(assistantMessage(`Decision: Drop${i} — short content ${i}`));
    }
    const messages: MessageLike[] = [
      ...olderDropped,
      assistantMessage('Decision: A — kept'),
      assistantMessage('Decision: B — kept'),
      assistantMessage('Decision: C — kept'),
    ];

    const distilled = buildCheckpointDistilledState(messages as never);

    // Overflow assertion: a single [DROPPED_DECISIONS_REMAINING: N] marker MUST appear
    // whenever dropped decisions exceed the tombstone-section budget.
    // Until Phase 3.2 implements the cap, this test FAILS — silent information loss.
    assert.match(
      distilled,
      /\[DROPPED_DECISIONS_REMAINING:\s*\d+\]/,
      `expected overflow count marker for 27 dropped decisions. Output:\n${distilled}`,
    );

    // The remaining count must be non-negative and consistent (kept-dropped count).
    const match = distilled.match(/\[DROPPED_DECISIONS_REMAINING:\s*(\d+)\]/);
    const remaining = Number(match?.[1] ?? -1);
    assert.ok(remaining >= 0, `DROPPED_DECISIONS_REMAINING count must be non-negative, got ${remaining}`);
  });
});

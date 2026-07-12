import { it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCheckpointDistilledState } from '../src/context-governor-checkpoint.js';
import { DEFAULT_GOVERNOR_CONFIG } from '../src/context-governor-profiles.js';
import { decisionFingerprint } from '../src/context-governor-awareness.js';

it('locks unique strictly increasing threshold ladders for every profile', () => {
  const ladders = Object.values(DEFAULT_GOVERNOR_CONFIG.profiles).map((profile) => [
    profile.thresholds.lightBrief,
    profile.thresholds.compactToolCalls,
    profile.thresholds.checkpointRefsOnly,
    profile.thresholds.distilledStateOnly,
    profile.thresholds.emergencyRebuild,
  ]);
  for (const ladder of ladders) {
    assert.ok(ladder.every((value, index) => index === 0 || value > ladder[index - 1]));
  }
  assert.equal(new Set(ladders.map((ladder) => ladder.join(':'))).size, ladders.length);
});

it('reconciles dropped decisions to retained tombstones plus overflow', () => {
  const output = buildCheckpointDistilledState(decisions(30) as never);
  const retained = output.match(/\[DROPPED_DECISION: /g)?.length ?? 0;
  const overflow = Number(output.match(/\[DROPPED_DECISIONS_REMAINING: (\d+)\]/)?.[1] ?? 0);
  const dropped = Number(output.match(/dropped_decisions_total=(\d+)/)?.[1] ?? -1);
  assert.equal(dropped, 27);
  assert.equal(dropped, retained + overflow);
  assert.match(output, new RegExp(`tombstones_created=${retained}`));
  assert.match(output, new RegExp(`tombstones_evicted=${overflow}`));
});

it('repeated compaction does not duplicate tombstones or inflate accounting', () => {
  const first = buildCheckpointDistilledState(decisions(8) as never);
  const second = buildCheckpointDistilledState([
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: first }] },
  ] as never);
  const firstIds = tombstoneIds(first);
  const secondIds = tombstoneIds(second);
  assert.ok(firstIds.length > 0);
  assert.deepEqual(secondIds, [], 'existing tombstone lines must not become decisions');
  assert.match(second, /Decision: D7/, 'genuine nearby decisions must remain extractable');
});

it('tombstones exactly decisions absent from the rendered surviving state', () => {
  const output = buildCheckpointDistilledState(decisions(5) as never);
  assert.match(output, /Decision: D2/);
  assert.match(output, /Decision: D3/);
  assert.match(output, /Decision: D4/);
  assert.doesNotMatch(output, new RegExp(`id=${decisionFingerprint(decisionText(2))}`));
  assert.match(output, new RegExp(`id=${decisionFingerprint(decisionText(0))}`));
  assert.match(output, new RegExp(`id=${decisionFingerprint(decisionText(1))}`));
});

it('produces identical bounded accounting under parallel compaction', async () => {
  const outputs = await Promise.all(Array.from({ length: 20 }, async () =>
    buildCheckpointDistilledState(decisions(30) as never)));
  assert.equal(new Set(outputs).size, 1);
});

function decisions(count: number): object[] {
  return Array.from({ length: count }, (_, index) => ({
    info: { role: 'assistant' },
    parts: [{ type: 'text', text: decisionText(index) }],
  }));
}

function decisionText(index: number): string {
  return `Decision: D${index} — contract choice ${index}`;
}

function tombstoneIds(text: string): string[] {
  return [...text.matchAll(/\[DROPPED_DECISION: id=([a-f0-9]+)/g)].map((match) => match[1]);
}

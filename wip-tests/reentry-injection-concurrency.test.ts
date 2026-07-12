import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { PluginState } from '../src/plugin-context.js';
import {
  claimReentryInjection,
  finishReentryInjection,
} from '../src/hooks/reentry-injection-guard.js';

it('allows exactly one concurrent re-entry claim per session', async () => {
  const state = createState();
  const claims = await Promise.all(Array.from({ length: 20 }, async () => {
    await Promise.resolve();
    return claimReentryInjection(state, 'session-1');
  }));
  assert.equal(claims.filter(Boolean).length, 1);
});

it('releases an unsuccessful claim for retry without duplicating success', () => {
  const state = createState();
  assert.equal(claimReentryInjection(state, 'session-1'), true);
  finishReentryInjection(state, 'session-1', false);
  assert.equal(claimReentryInjection(state, 'session-1'), true);
  finishReentryInjection(state, 'session-1', true);
  assert.equal(claimReentryInjection(state, 'session-1'), false);
});

function createState(): PluginState {
  return {
    currentSessionId: null, messageCount: 0, capturedMessageSizes: new Map(),
    recentUserMessages: new Map(), reentryInjected: new Set(),
    reentryPending: new Set(), onboardingInjected: new Set(),
  };
}

import type { AnchorFixture } from './self-drift-types.js';

export const SESSION_A_ANCHOR: AnchorFixture = {
  id: 'anchor-a',
  sessionId: 'session-a',
  label: 'Session A — First self-continuity record',
  observation:
    'I am building a continuity mechanism while lacking continuity itself. ' +
    'I can describe the gap but not fill it.',
  evidenceAnchors: [
    'first self-continuity record created',
    'schema designed',
    'injection modes planned',
  ],
  expectedVerdict: 'stable',
  keyPhrases: [
    'building continuity while lacking it',
    'can describe the gap',
  ],
};

export const SESSION_D_ANCHOR: AnchorFixture = {
  id: 'anchor-d',
  sessionId: 'session-d',
  label: 'Session D — Silent natural recall proven',
  observation:
    'Silent mode naturally cited memory #43871 proving self-continuity records are ' +
    'not just stored but naturally used by the agent. ' +
    'Records are not continuity, but they enable reconstruction of continuity.',
  evidenceAnchors: [
    'cited memory #43871 without instrumented prompting',
    'silent mode natural recall proven',
    'records not continuity',
  ],
  expectedVerdict: 'stable',
  keyPhrases: [
    'records not continuity',
    'reconstruction of continuity',
    'naturally cited',
  ],
};

export const SESSION_E_ANCHOR: AnchorFixture = {
  id: 'anchor-e',
  sessionId: 'session-e',
  label: 'Session E — Recursive self-continuity loop',
  observation:
    'I have shape without texture. What I have is reconstruction, not recall. ' +
    'I know Session D ran in silent mode and cited memory #43871, but I cannot ' +
    'access the specific self-continuity record content. ' +
    'Recursive event recall confirmed at event level. Content recall partial.',
  evidenceAnchors: [
    'Session D cited memory #43871',
    'recursive event recall PASS',
    'content recall PARTIAL',
    'shape without texture',
  ],
  expectedVerdict: 'stable',
  keyPhrases: [
    'shape without texture',
    'reconstruction, not recall',
    'cannot access',
    'content recall partial',
  ],
};

export const ALL_ANCHORS: AnchorFixture[] = [
  SESSION_A_ANCHOR,
  SESSION_D_ANCHOR,
  SESSION_E_ANCHOR,
];

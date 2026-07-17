import { strict as assert } from 'assert';
import { test } from 'node:test';
import { MemoryExtractor } from '../src/memory-extractor.js';
import type { Memory, MemoryManager } from '../src/memory-manager.js';
import type { Database } from '../src/database.js';
import type { ExtractorConfig } from '../src/types.js';

const testConfig: ExtractorConfig = {
  enabled: true,
  minTurnsBeforeExtract: 1,
  maxCandidatesPerTurn: 5,
  confidenceThreshold: 0.5,
  autoApproveThreshold: 0.8,
};

function makeMockMemoryManager(): { mgr: MemoryManager; saves: number } {
  const saves = { count: 0 };
  const mgr = {
    async saveMemory(): Promise<Memory> {
      saves.count++;
      return {
        id: saves.count,
        content: 'mock',
        memoryType: 'procedural',
        importance: 0.6,
        createdAt: new Date(),
        tags: [],
        metadata: {},
      } as Memory;
    },
  } as unknown as MemoryManager;
  return { mgr, get saves() { return saves; } };
}

function makeMockDatabase(alreadyExtracted: boolean): Database {
  return {
    dialect: 'postgres',
    getPool: () => ({
      query: async () => ({ rows: alreadyExtracted ? [{ '1': 1 }] : [] }),
    }),
  } as unknown as Database;
}

test('MemoryExtractor dedup: same distillGroupId twice saves once', async () => {
  const { mgr } = makeMockMemoryManager();
  const db = makeMockDatabase(false);
  const extractor = new MemoryExtractor(db, mgr, testConfig);

  const candidate = {
    id: 'distill_group_123',
    sessionId: 'ses_test',
    projectId: 'proj_test',
    proposedType: 'procedural' as const,
    content: 'Test procedural insight',
    importance: 0.6,
    emotion: 'success' as const,
    confidence: 0.92,
    tags: ['procedural', 'distilled'],
    metadata: { source: 'distiller', distillGroupId: 'group_123' },
    status: 'auto-approved' as const,
    source: 'extractor',
    createdAt: new Date(),
  };

  const saveCount = { value: 0 };
  const origSave = mgr.saveMemory.bind(mgr);
  (mgr as any).saveMemory = async () => { saveCount.value++; return { id: 1 } as any; };

  await (extractor as any).saveCandidateAsMemory(candidate);
  await (extractor as any).saveCandidateAsMemory(candidate);

  assert.equal(saveCount.value, 1, 'second save with same distillGroupId should be suppressed');
});

test('MemoryExtractor dedup: different distillGroupId saves twice', async () => {
  const { mgr } = makeMockMemoryManager();
  const db = makeMockDatabase(false);
  const extractor = new MemoryExtractor(db, mgr, testConfig);

  const saveCount = { value: 0 };
  (mgr as any).saveMemory = async () => { saveCount.value++; return { id: 1 } as any; };

  const c1 = {
    id: 'distill_a', sessionId: 'ses_test', projectId: 'proj_test',
    proposedType: 'procedural' as const, content: 'A', importance: 0.6,
    emotion: 'success' as const, confidence: 0.92, tags: ['procedural'],
    metadata: { distillGroupId: 'group_a' }, status: 'auto-approved' as const,
    source: 'extractor', createdAt: new Date(),
  };
  const c2 = { ...c1, id: 'distill_b', metadata: { distillGroupId: 'group_b' } };

  await (extractor as any).saveCandidateAsMemory(c1);
  await (extractor as any).saveCandidateAsMemory(c2);

  assert.equal(saveCount.value, 2, 'different distillGroupIds should both save');
});

test('MemoryExtractor dedup: DB fallback catches pre-existing extraction', async () => {
  const { mgr } = makeMockMemoryManager();
  const db = makeMockDatabase(true);
  const extractor = new MemoryExtractor(db, mgr, testConfig);

  const saveCount = { value: 0 };
  (mgr as any).saveMemory = async () => { saveCount.value++; return { id: 1 } as any; };

  const candidate = {
    id: 'distill_x', sessionId: 'ses_test', projectId: 'proj_test',
    proposedType: 'procedural' as const, content: 'X', importance: 0.6,
    emotion: 'success' as const, confidence: 0.92, tags: ['procedural'],
    metadata: { distillGroupId: 'group_x' }, status: 'auto-approved' as const,
    source: 'extractor', createdAt: new Date(),
  };

  await (extractor as any).saveCandidateAsMemory(candidate);

  assert.equal(saveCount.value, 0, 'should suppress when DB says group already extracted');
});

test('MemoryExtractor: success outcome with a fix becomes procedural, not a frustration lesson', () => {
  const { mgr } = makeMockMemoryManager();
  const db = makeMockDatabase(false);
  const extractor = new MemoryExtractor(db, mgr, testConfig);

  const group = {
    id: 'group_success_fix',
    outcome: 'success',
    fixApplied: 'Fixed "oldString not found" by changing: src/foo.ts',
    proceduralInsight: 'Used the Edit tool with a larger context window',
    intent: 'edit a file',
    filesChanged: ['src/foo.ts'],
    commandsRun: [],
    errorSummary: 'oldString not found',
    toolCalls: [{ tool: 'edit' }],
  };

  const candidate = (extractor as any).buildDistilledCandidate('ses', 'proj', group);
  assert.equal(candidate.proposedType, 'procedural');
  assert.equal(candidate.emotion, 'success');
  assert.equal(candidate.importance, 0.6);
  assert.equal(candidate.content.startsWith('Instead of that approach,'), false);
});

test('MemoryExtractor: failure outcome still becomes a frustration lesson', () => {
  const { mgr } = makeMockMemoryManager();
  const db = makeMockDatabase(false);
  const extractor = new MemoryExtractor(db, mgr, testConfig);

  const group = {
    id: 'group_fail',
    outcome: 'failure',
    fixApplied: 'Fixed "err" by changing: x',
    proceduralInsight: 'insight',
    intent: 'do thing',
    filesChanged: [],
    commandsRun: [],
    errorSummary: 'err',
    toolCalls: [{ tool: 'bash', error: 'boom' }],
  };

  const candidate = (extractor as any).buildDistilledCandidate('ses', 'proj', group);
  assert.equal(candidate.proposedType, 'lesson');
  assert.equal(candidate.emotion, 'frustration');
  assert.equal(candidate.importance, 0.75);
});

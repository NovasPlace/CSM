import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { CodexMemoryBridge } from '../dist/codex-bridge.js';

const tempDir = '.tmp/sqlite-codex-bridge';
const dbPath = `${tempDir}/bridge.sqlite`;

function removeDatabase(): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { rmSync(path); } catch { /* absent */ }
  }
}

describe('SQLite Codex bridge', () => {
  beforeEach(() => {
    mkdirSync(tempDir, { recursive: true });
    removeDatabase();
  });

  afterEach(() => {
    removeDatabase();
    try { rmSync(tempDir); } catch { /* absent */ }
  });

  it('supports the advertised core-memory surface and rejects full-runtime operations clearly', async () => {
    const bridge = await CodexMemoryBridge.connect({
      databaseProvider: 'sqlite',
      sqlitePath: dbPath,
    });

    try {
      await bridge.saveMemory({
        projectRoot: 'sqlite-bridge-project',
        content: 'BridgeSQLite saved src/bridge-core.ts for entity filtering.',
        type: 'lesson',
      });
      await bridge.saveMemory({
        projectRoot: 'sqlite-bridge-project',
        content: 'BridgeSQLite saved a second searchable core memory.',
        type: 'lesson',
      });

      const search = await bridge.searchMemories({
        query: 'BridgeSQLite',
        projectId: 'sqlite-bridge-project',
        limit: 10,
      });
      assert.equal(search.results.length, 2);
      assert.equal(search.cascaded.length, 2);
      assert.ok(search.cascaded.every((memory) => memory.accessedAt instanceof Date));

      const listed = await bridge.listMemories({
        projectId: 'sqlite-bridge-project',
        dateFrom: new Date(Date.now() - 3_600_000),
        entityType: 'file',
        entityValue: 'src/bridge-core.ts',
      });
      assert.equal(listed.length, 1);

      const projects = await bridge.invokeExtra('memory_project_list', {}) as { projects: unknown[] };
      assert.equal(projects.projects.length, 1);
      assert.ok(bridge.listTools().includes('save_memory'));
      assert.ok(!bridge.listTools().includes('get_compaction_report'));
      assert.ok(!bridge.listTools().includes('goal_list'));
      assert.ok(!bridge.listTools().includes('work_ledger_surviving'));

      await assert.rejects(
        () => bridge.getCompactionReport(),
        /unavailable in SQLite core-memory mode/,
      );
      await assert.rejects(
        () => bridge.getSurvivingWorkChanges({ runId: 'sqlite-run' }),
        /unavailable in SQLite core-memory mode/,
      );
      await assert.rejects(
        () => bridge.invokeExtra('goal_list', { sessionId: 'sqlite-bridge-session' }),
        /unavailable in SQLite core-memory mode/,
      );
    } finally {
      await bridge.disconnect();
    }
  });
});

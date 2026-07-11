import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  queueDocUpdate, flushDocUpdates, getPendingUpdates, clearPendingUpdates,
  resetSessionFlushState, clearPendingDocUpdates, ensureProjectDocsInitialized,
  invalidateProject, isProjectInitialized,
} from "../src/hooks/auto-docs.js";
import { projectKey } from "../src/hooks/doc-project-key.js";
import { clearAllFlushTimers, scheduleDocFlushLocal, manualFlushProject } from "../src/hooks/tool-execute-memory.js";
import { dirsToClean, installAutoDocsTestHooks, makePluginContext, makeSourceFile, makeTempDir, readDocIfExists } from "./auto-docs-repair-fixture.js";

installAutoDocsTestHooks();

describe("auto-docs repair — path case normalization", () => {
  it("normalizes Windows project path case", { skip: process.platform !== "win32" }, () => {
    const dir = makeTempDir("case-key");
    dirsToClean.push(dir);
    assert.equal(projectKey(dir), projectKey(dir.toUpperCase()));
  });
});

describe("auto-docs repair — disposal timer cleanup", () => {
  it("disposal cancels pending auto-docs timers so callbacks do not fire after teardown", async () => {
    const dir = makeTempDir("dispose-timer");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(dir);

    makeSourceFile(dir, "src/late.ts", "export const late: number = 999;\n");
    queueDocUpdate("src/late.ts", "write", dir);
    const ctx = makePluginContext(dir);
    scheduleDocFlushLocal(ctx);

    clearAllFlushTimers();

    await new Promise(resolve => setTimeout(resolve, 2500));

    assert.ok(getPendingUpdates(dir).length > 0, "pending update should survive disposal (timer was cancelled)");
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(!sm.includes("late"), "late.ts should NOT appear in SYSTEM_MAP (timer was cancelled before firing)");

    clearPendingUpdates(dir);
  });

  it("repeated disposal (clearAllFlushTimers) does not throw", () => {
    clearAllFlushTimers();
    clearAllFlushTimers();
    clearAllFlushTimers();
  });
});

describe("auto-docs repair — invalidation vs in-flight init", () => {
  it("invalidation during in-flight init prevents marking project initialized", async () => {
    const dir = makeTempDir("gen-invalidate");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    makeSourceFile(dir, "src/large.ts", `export const data: number[] = [\n${Array.from({ length: 50 }, (_, i) => `  ${i},`).join("\n")}\n];\n`);

    const initPromise = ensureProjectDocsInitialized(dir);
    invalidateProject(dir);
    await initPromise;

    assert.ok(!isProjectInitialized(dir), "project must NOT be initialized after invalidation won over in-flight init");

    await ensureProjectDocsInitialized(dir);
    assert.ok(isProjectInitialized(dir), "project should be initialized after fresh retry");
  });

  it("failed initialization can be retried", async () => {
    const dir = makeTempDir("retry-failed");
    dirsToClean.push(dir);

    try {
      await ensureProjectDocsInitialized(dir);
    } catch {
      // May or may not throw depending on implementation
    }

    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    invalidateProject(dir);
    await ensureProjectDocsInitialized(dir);
    assert.ok(isProjectInitialized(dir), "retry should succeed after adding source files");
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("index.ts"), "retry should produce correct SYSTEM_MAP");
  });
});

describe("auto-docs repair — session preservation and clear", () => {
  it("session.created preserves pending updates (resetSessionFlushState does not clear queue)", async () => {
    const dir = makeTempDir("session-preserve");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(dir);

    makeSourceFile(dir, "src/before-session.ts", "export const before: number = 1;\n");
    queueDocUpdate("src/before-session.ts", "write", dir);
    const beforeCount = getPendingUpdates(dir).length;
    assert.ok(beforeCount > 0, "update should be pending before session.created");

    resetSessionFlushState(dir);

    const afterCount = getPendingUpdates(dir).length;
    assert.equal(afterCount, beforeCount, "pending updates must survive session.created");

    const ctx = makePluginContext(dir);
    await flushDocUpdates(ctx, dir);

    assert.equal(getPendingUpdates(dir).length, 0, "pending updates consumed after flush");
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("before-session"), "before-session.ts should appear in SYSTEM_MAP after flush");
  });

  it("clearPendingDocUpdates is destructive (removes queued updates)", async () => {
    const dir = makeTempDir("destructive-clear");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(dir);

    makeSourceFile(dir, "src/queued.ts", "export const queued: number = 1;\n");
    queueDocUpdate("src/queued.ts", "write", dir);
    assert.ok(getPendingUpdates(dir).length > 0, "update should be pending");

    clearPendingDocUpdates(dir);
    assert.equal(getPendingUpdates(dir).length, 0, "pending updates should be cleared by clearPendingDocUpdates");
  });
});

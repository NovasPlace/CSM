// Auto-docs repair regression tests.
// Covers: per-workfolder initialization, projectDir threading, missing/malformed
// doc bootstrap, per-project queue/timer isolation, concurrent init, detach-
// before-flush, failed-flush restore, race-safe timers, changelog entry cap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  queueDocUpdate,
  flushDocUpdates,
  getPendingUpdates,
  clearPendingUpdates,
  resetSessionFlushState,
  clearPendingDocUpdates,
  ensureProjectDocsInitialized,
  invalidateProject,
  isProjectInitialized,
} from "../src/hooks/auto-docs.js";
import { reconcileSystemMap } from "../src/hooks/doc-analyzer.js";
import { projectKey } from "../src/hooks/doc-project-key.js";
import { clearAllFlushTimers, scheduleDocFlushLocal, manualFlushProject } from "../src/hooks/tool-execute-memory.js";
import type { PluginContext } from "../src/plugin-context.js";
import { dirsToClean, installAutoDocsTestHooks, makePluginContext, makeSourceFile, makeTempDir, readDocIfExists } from "./auto-docs-repair-fixture.js";

installAutoDocsTestHooks();

function makeCapContext(directory: string, maxEntryLength: number, maxChangelogEntriesPerSession: number): PluginContext {
  return {
    directory,
    config: { autoDocs: { maxEntryLength, maxChangelogEntriesPerSession } },
    state: {},
    sessionId: "test-session",
  } as unknown as PluginContext;
}

function countFileRefs(dir: string, prefix: string): number {
  const changelog = readDocIfExists(dir, "CHANGELOG_LIVE.md");
  if (!changelog) return 0;
  const matches = changelog.match(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
  return matches ? matches.length : 0;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// =====================================================
// Session initialization
// =====================================================
describe("auto-docs repair — session initialization", () => {
  it("first session initializes docs", async () => {
    const dir = makeTempDir("init-first");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");

    await ensureProjectDocsInitialized(dir);

    assert.ok(existsSync(join(dir, "docs", "SYSTEM_MAP.md")), "SYSTEM_MAP.md should exist");
    assert.ok(existsSync(join(dir, "docs", "CHANGELOG_LIVE.md")), "CHANGELOG_LIVE.md should exist");
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.length > 0, "SYSTEM_MAP.md should not be blank");
  });

  it("second session in same workfolder remains functional", async () => {
    const dir = makeTempDir("init-second");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");

    await ensureProjectDocsInitialized(dir);
    assert.ok(isProjectInitialized(dir));

    invalidateProject(dir);
    assert.ok(!isProjectInitialized(dir));

    await ensureProjectDocsInitialized(dir);
    assert.ok(isProjectInitialized(dir));

    makeSourceFile(dir, "src/new-file.ts", "export function helper() { return 1; }\n");
    queueDocUpdate("src/new-file.ts", "write", dir);
    const ctx = makePluginContext(dir);
    await flushDocUpdates(ctx, dir);

    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("new-file"), "SYSTEM_MAP should include new file");
  });
});

// =====================================================
// Workfolder isolation
// =====================================================
describe("auto-docs repair — workfolder isolation", () => {
  it("different workfolder creates and updates its own docs", async () => {
    const dirA = makeTempDir("isolated-a");
    const dirB = makeTempDir("isolated-b");
    dirsToClean.push(dirA, dirB);
    makeSourceFile(dirA, "src/a.ts", "export const aValue: number = 100;\n");
    makeSourceFile(dirB, "src/b.ts", "export const bValue: number = 200;\n");

    await ensureProjectDocsInitialized(dirA);
    await ensureProjectDocsInitialized(dirB);

    const smA = readDocIfExists(dirA, "SYSTEM_MAP.md");
    const smB = readDocIfExists(dirB, "SYSTEM_MAP.md");
    assert.ok(smA.includes("a.ts"), "A should reference a.ts");
    assert.ok(!smA.includes("b.ts"), "A should NOT reference b.ts");
    assert.ok(smB.includes("b.ts"), "B should reference b.ts");
    assert.ok(!smB.includes("a.ts"), "B should NOT reference a.ts");

    const smABefore = smA;
    makeSourceFile(dirB, "src/b2.ts", "export const b2Value: number = 500;\n");
    queueDocUpdate("src/b2.ts", "write", dirB);
    const ctxB = makePluginContext(dirB);
    await flushDocUpdates(ctxB, dirB);

    const smAAfter = readDocIfExists(dirA, "SYSTEM_MAP.md");
    assert.equal(smAAfter, smABefore, "A's docs must be unchanged after B flush");
    const smBAfter = readDocIfExists(dirB, "SYSTEM_MAP.md");
    assert.ok(smBAfter.includes("b2"), "B's docs should include b2");
  });
});

// =====================================================
// CWD isolation
// =====================================================
describe("auto-docs repair — CWD isolation", () => {
  it("cwd !== projectDir writes nothing into CWD docs", async () => {
    const cwdDir = makeTempDir("cwd-dummy");
    const projectDir = makeTempDir("project-real");
    dirsToClean.push(cwdDir, projectDir);
    makeSourceFile(cwdDir, "src/real.ts", "export function real() { return 1; }\n// DECISION: cwd-marker\n");
    makeSourceFile(projectDir, "src/real.ts", "export function real() { return 1; }\n// DECISION: project-marker\n");

    const testScript = `
      const { promises: fs } = require("fs");
      const { join } = require("path");
      const { ensureProjectDocsInitialized, flushDocUpdates, queueDocUpdate } = require("${join(process.cwd(), "dist", "hooks", "auto-docs.js").replace(/\\/g, "\\\\")}");

      (async () => {
        process.chdir(${JSON.stringify(cwdDir)});
        const projectDir = ${JSON.stringify(projectDir)};
        await ensureProjectDocsInitialized(projectDir);
        queueDocUpdate("src/real.ts", "write", projectDir);
        await flushDocUpdates({ directory: projectDir, config: {}, state: {}, sessionId: "child" }, projectDir);
        try { await fs.access(join(process.cwd(), "docs")); process.exit(1); } catch { /* expected */ }
        try { await fs.access(join(projectDir, "docs", "SYSTEM_MAP.md")); } catch { process.exit(2); }
        const decisions = await fs.readFile(join(projectDir, "docs", "DECISIONS.md"), "utf8");
        if (!decisions.includes("project-marker") || decisions.includes("cwd-marker")) process.exit(4);
        process.exit(0);
      })().catch(() => process.exit(3));
    `;
    writeFileSync(join(cwdDir, "_cwd_test.js"), testScript, "utf-8");
    try {
      execFileSync("node", [join(cwdDir, "_cwd_test.js")], { cwd: cwdDir, timeout: 30000, stdio: "pipe" });
    } catch (err: unknown) {
      const e = err as { status?: number };
      if (e.status === 1) assert.fail("CWD docs should NOT have been created");
      if (e.status === 2) assert.fail("Project docs SHOULD have been created");
      if (e.status === 3) assert.fail("Child process threw");
      if (e.status === 4) assert.fail("Queued update must read the target project, not CWD");
      throw err;
    }
  });
});

// =====================================================
// SYSTEM_MAP rebuild and repair
// =====================================================
describe("auto-docs repair — SYSTEM_MAP rebuild and repair", () => {
  it("missing SYSTEM_MAP.md is rebuilt", async () => {
    const dir = makeTempDir("rebuild-missing");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    mkdirSync(join(dir, "docs"), { recursive: true });

    const result = await reconcileSystemMap(join(dir, "docs"), dir);
    assert.ok(result.added > 0, "should have added entries");
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.length > 0, "SYSTEM_MAP.md should be created");
    assert.ok(sm.includes("index.ts"), "should reference index.ts");
  });

  it("malformed SYSTEM_MAP.md without table header self-heals", async () => {
    const dir = makeTempDir("malformed-header");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "SYSTEM_MAP.md"), "# System Map\n\n## Src\n\nSome prose but no table.\n", "utf-8");

    await reconcileSystemMap(join(dir, "docs"), dir);

    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    const headingCount = (sm.match(/## Src/g) ?? []).length;
    assert.equal(headingCount, 1, "should have exactly one ## Src heading");
    assert.ok(sm.includes("| File | Exports | Type | Role |"), "table header should be present");
    assert.ok(sm.includes("index.ts"), "should reference index.ts");
  });
});

// =====================================================
// Workfolder queue and timer isolation
// =====================================================
describe("auto-docs repair — workfolder queue isolation", () => {
  it("simultaneous updates for workfolders A and B remain isolated", async () => {
    const dirA = makeTempDir("simul-a");
    const dirB = makeTempDir("simul-b");
    dirsToClean.push(dirA, dirB);
    makeSourceFile(dirA, "src/a.ts", "export const aValue: number = 100;\n");
    makeSourceFile(dirB, "src/b.ts", "export const bValue: number = 200;\n");
    await ensureProjectDocsInitialized(dirA);
    await ensureProjectDocsInitialized(dirB);

    makeSourceFile(dirA, "src/a2.ts", "export const a2Value: number = 300;\n");
    makeSourceFile(dirB, "src/b2.ts", "export const b2Value: number = 400;\n");
    queueDocUpdate("src/a2.ts", "write", dirA);
    queueDocUpdate("src/b2.ts", "write", dirB);

    const ctxA = makePluginContext(dirA);
    await flushDocUpdates(ctxA, dirA);

    assert.equal(getPendingUpdates(dirA).length, 0, "A queue should be empty after flush");
    assert.ok(getPendingUpdates(dirB).length > 0, "B queue should still have pending update");
  });
});

describe("auto-docs repair — timer isolation", () => {
  it("flushing A does not cancel B's timer or consume B's queue", async () => {
    const dirA = makeTempDir("timer-a");
    const dirB = makeTempDir("timer-b");
    dirsToClean.push(dirA, dirB);
    makeSourceFile(dirA, "src/a.ts", "export const aValue: number = 100;\n");
    makeSourceFile(dirB, "src/b.ts", "export const bValue: number = 200;\n");
    await ensureProjectDocsInitialized(dirA);
    await ensureProjectDocsInitialized(dirB);

    makeSourceFile(dirA, "src/a2.ts", "export const a2Value: number = 300;\n");
    makeSourceFile(dirB, "src/b2.ts", "export const b2Value: number = 400;\n");

    const ctxA = makePluginContext(dirA);
    const ctxB = makePluginContext(dirB);
    queueDocUpdate("src/a2.ts", "write", dirA);
    queueDocUpdate("src/b2.ts", "write", dirB);
    scheduleDocFlushLocal(ctxA);
    scheduleDocFlushLocal(ctxB);

    await manualFlushProject(ctxA);

    assert.ok(getPendingUpdates(dirB).length > 0, "B queue should still have pending update after A flush");

    await new Promise(resolve => setTimeout(resolve, 2500));
    assert.equal(getPendingUpdates(dirB).length, 0, "B queue should be consumed by its own timer");
    const smB = readDocIfExists(dirB, "SYSTEM_MAP.md");
    assert.ok(smB.includes("b2"), "B's docs should have b2 after timer flush");
  });
});

// =====================================================
// Idempotent and concurrent init
// =====================================================
describe("auto-docs repair — idempotent and concurrent init", () => {
  it("repeated initialization is idempotent", async () => {
    const dir = makeTempDir("idempotent");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");

    await ensureProjectDocsInitialized(dir);
    const smAfterFirst = readDocIfExists(dir, "SYSTEM_MAP.md");
    const headingCountFirst = (smAfterFirst.match(/## Src/g) ?? []).length;

    invalidateProject(dir);
    await ensureProjectDocsInitialized(dir);
    invalidateProject(dir);
    await ensureProjectDocsInitialized(dir);

    const smAfterThird = readDocIfExists(dir, "SYSTEM_MAP.md");
    const headingCountThird = (smAfterThird.match(/## Src/g) ?? []).length;
    assert.equal(headingCountThird, headingCountFirst, "no duplicate headings after 3x init");
    assert.ok(smAfterThird.includes("index.ts"), "file entry preserved");
  });

  it("concurrent initialization of the same workfolder is serialized", async () => {
    const dir = makeTempDir("concurrent-init");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");

    const promises = Array.from({ length: 5 }, () => ensureProjectDocsInitialized(dir));
    await Promise.all(promises);

    assert.ok(isProjectInitialized(dir), "should be initialized after concurrent inits");
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    const headingCount = (sm.match(/## Src/g) ?? []).length;
    assert.equal(headingCount, 1, "no duplicate headings from concurrent init");
  });
});

// =====================================================
// Document preservation
// =====================================================
describe("auto-docs repair — document preservation", () => {
  it("existing populated documents retain their content and structure", async () => {
    const dir = makeTempDir("preserve");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    makeSourceFile(dir, "src/config.ts", "export const config = { port: 3000 };\n");

    mkdirSync(join(dir, "docs"), { recursive: true });
    const existingContent = `# System Map\n\n> Auto-generated architecture reference.\n\n## Src\n\n| File | Exports | Type | Role |\n|------|---------|------|------|\n| \`src/index.ts\` | main | module | Hook handler |\n`;
    writeFileSync(join(dir, "docs", "SYSTEM_MAP.md"), existingContent, "utf-8");

    await reconcileSystemMap(join(dir, "docs"), dir);

    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("src/index.ts"), "existing index.ts entry preserved");
    assert.ok(sm.includes("config.ts"), "new config.ts entry added");
    const headingCount = (sm.match(/## Src/g) ?? []).length;
    assert.equal(headingCount, 1, "no duplicate ## Src heading");
  });
});

// =====================================================
// Queue-during-flush and batch handling
// =====================================================
describe("auto-docs repair — queue-during-flush", () => {
  it("updates queued while a flush is awaiting enter a new bucket", async () => {
    const dir = makeTempDir("queue-during-flush");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(dir);

    makeSourceFile(dir, "src/a.ts", "export const aValue: number = 100;\n");
    queueDocUpdate("src/a.ts", "write", dir);

    const ctx = makePluginContext(dir);
    const flushPromise = flushDocUpdates(ctx, dir);
    makeSourceFile(dir, "src/b.ts", "export const bValue: number = 200;\n");
    queueDocUpdate("src/b.ts", "write", dir);
    await flushPromise;

    assert.ok(getPendingUpdates(dir).length > 0, "b.ts should still be pending after first flush");
    await flushDocUpdates(ctx, dir);
    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("a.ts"), "a.ts should be in SYSTEM_MAP");
    assert.ok(sm.includes("b.ts"), "b.ts should be in SYSTEM_MAP");
  });
});

// =====================================================
// Failed flush restore
// =====================================================
describe("auto-docs repair — failed flush restore", () => {
  it("failed flush restores its batch without overwriting newer updates", async () => {
    const dir = makeTempDir("failed-flush");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(dir);

    makeSourceFile(dir, "src/a.ts", "export const aValue: number = 100;\n");
    queueDocUpdate("src/a.ts", "write", dir);

    const docsDir = join(dir, "docs");
    const changelogPath = join(docsDir, "CHANGELOG_LIVE.md");
    writeFileSync(changelogPath, "# CHANGELOG_LIVE.md\n\n## Development Log\n\n", "utf-8");
    try { await fs.chmod(changelogPath, 0o444); } catch { /* may not work on Windows */ }

    const ctx = makePluginContext(dir);
    try { await flushDocUpdates(ctx, dir); } catch { /* expected on some platforms */ }

    try { await fs.chmod(changelogPath, 0o644); } catch { /* ignore */ }

    const pending = getPendingUpdates(dir);
    assert.ok(pending.some(u => u.filePath === "src/a.ts"), "a.ts should be restored after failed flush");
  });
});

// =====================================================
// Manual flush isolation
// =====================================================
describe("auto-docs repair — manual flush isolation", () => {
  it("manual flush clears only its own timer", async () => {
    const dirA = makeTempDir("manual-a");
    const dirB = makeTempDir("manual-b");
    dirsToClean.push(dirA, dirB);
    makeSourceFile(dirA, "src/a.ts", "export const aValue: number = 100;\n");
    makeSourceFile(dirB, "src/b.ts", "export const bValue: number = 200;\n");
    await ensureProjectDocsInitialized(dirA);
    await ensureProjectDocsInitialized(dirB);

    const ctxA = makePluginContext(dirA);
    const ctxB = makePluginContext(dirB);

    makeSourceFile(dirA, "src/a2.ts", "export const a2Value: number = 300;\n");
    makeSourceFile(dirB, "src/b2.ts", "export const b2Value: number = 400;\n");
    queueDocUpdate("src/a2.ts", "write", dirA);
    queueDocUpdate("src/b2.ts", "write", dirB);
    scheduleDocFlushLocal(ctxA);
    scheduleDocFlushLocal(ctxB);

    await manualFlushProject(ctxA);

    assert.ok(getPendingUpdates(dirB).length > 0, "B queue intact after A manual flush");
  });
});

// =====================================================
// Malformed heading and path containment
// =====================================================
describe("auto-docs repair — malformed heading and path containment", () => {
  it("one existing malformed heading produces exactly one repaired heading", async () => {
    const dir = makeTempDir("one-heading");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    makeSourceFile(dir, "src/config.ts", "export const config = { port: 3000 };\n");
    makeSourceFile(dir, "lib/cache.ts", "export function cache() { return 42; }\n");

    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "SYSTEM_MAP.md"), "# System Map\n\n## Src\n\nSome description.\n\n## Lib\n\n| File | Exports | Type | Role |\n|------|---------|------|------|\n", "utf-8");

    await reconcileSystemMap(join(dir, "docs"), dir);

    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    const headingCount = (sm.match(/## Src/g) ?? []).length;
    assert.equal(headingCount, 1, "exactly one ## Src heading");
    const tableCount = (sm.match(/\| File \| Exports \| Type \| Role \|/g) ?? []).length;
    assert.equal(tableCount, 2, "each section has exactly one table header");
    const srcSection = sm.slice(sm.indexOf("## Src"), sm.indexOf("## Lib"));
    const libSection = sm.slice(sm.indexOf("## Lib"));
    assert.ok(srcSection.includes("src/index.ts"), "src rows remain under Src");
    assert.ok(!srcSection.includes("lib/cache.ts"), "lib rows do not leak into Src");
    assert.ok(libSection.includes("lib/cache.ts"), "lib rows remain under Lib");
  });

  it("rejects a sibling project path without documenting it", async () => {
    const root = makeTempDir("containment");
    const projectDir = join(root, "repo");
    const siblingDir = join(root, "repo-other");
    dirsToClean.push(root);
    makeSourceFile(siblingDir, "src/escape.ts", "export const escape = 1;\n// DECISION: external\n");

    queueDocUpdate("../repo-other/src/escape.ts", "write", projectDir);
    await flushDocUpdates(makePluginContext(projectDir), projectDir);

    assert.equal(getPendingUpdates(projectDir).length, 0, "rejected update is consumed");
    assert.equal(readDocIfExists(projectDir, "CHANGELOG_LIVE.md"), "", "rejected path is not logged");
    assert.equal(readDocIfExists(projectDir, "DECISIONS.md"), "", "external content is not documented");
  });
});

// =====================================================
// Path case normalization and disposal cleanup
// =====================================================
describe("auto-docs repair — path case and disposal", () => {
  it("normalizes Windows project path case", { skip: process.platform !== "win32" }, () => {
    const dir = makeTempDir("case-key");
    dirsToClean.push(dir);
    assert.equal(projectKey(dir), projectKey(dir.toUpperCase()));
  });

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

// =====================================================
// Invalidation vs in-flight init
// =====================================================
describe("auto-docs repair — invalidation during init", () => {
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
});

// =====================================================
// Failed init retry
// =====================================================
describe("auto-docs repair — failed init retry", () => {
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

// =====================================================
// Session preservation and clear
// =====================================================
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

// =====================================================
// README path handling
// =====================================================
describe("auto-docs repair — README path handling", () => {
  it("subconscious README processing produces project-relative paths in SYSTEM_MAP", async () => {
    const projectDir = makeTempDir("subconscious-relative");
    dirsToClean.push(projectDir);
    makeSourceFile(projectDir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(projectDir);

    makeSourceFile(projectDir, "src/newmod/utils.ts", "export const utils: number = 1;\n");
    queueDocUpdate("src/newmod/utils.ts", "write", projectDir);

    const ctx = makePluginContext(projectDir);
    await flushDocUpdates(ctx, projectDir);

    const sm = readDocIfExists(projectDir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("newmod"), "SYSTEM_MAP should reference newmod directory");
    assert.ok(!sm.includes(projectDir.replace(/\\/g, "/")), "SYSTEM_MAP should not contain absolute project path");
    assert.ok(!sm.includes(projectDir), "SYSTEM_MAP should not contain absolute project path (raw)");
  });

  it("README path is project-relative regardless of process.cwd()", async () => {
    const projectDir = makeTempDir("readme-cwd-independent");
    dirsToClean.push(projectDir);
    makeSourceFile(projectDir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(projectDir);

    makeSourceFile(projectDir, "src/guide.ts", "export const guide: number = 1;\n");
    queueDocUpdate("src/guide.ts", "write", projectDir);

    const ctx = makePluginContext(projectDir);
    await flushDocUpdates(ctx, projectDir);

    const sm = readDocIfExists(projectDir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("guide"), "guide.ts should appear in SYSTEM_MAP");
    assert.ok(!sm.includes(projectDir.replace(/\\/g, "/")), "SYSTEM_MAP should not contain absolute path");
  });
});

// =====================================================
// Absolute path rejection
// =====================================================
describe("auto-docs repair — absolute path rejection", () => {
  it("absolute path inside project is normalized to relative for SYSTEM_MAP", async () => {
    const dir = makeTempDir("abs-in-project");
    dirsToClean.push(dir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    await ensureProjectDocsInitialized(dir);

    makeSourceFile(dir, "src/abs-test.ts", "export const absTest: number = 1;\n");
    const absPath = join(dir, "src", "abs-test.ts");
    queueDocUpdate(absPath, "write", dir);

    const ctx = makePluginContext(dir);
    await flushDocUpdates(ctx, dir);

    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(sm.includes("abs-test"), "abs-test.ts should appear in SYSTEM_MAP");
    assert.ok(!sm.includes(dir.replace(/\\/g, "/")), "SYSTEM_MAP should not contain absolute path");
  });

  it("absolute path outside project is rejected from queue", async () => {
    const dir = makeTempDir("abs-outside");
    const outsideDir = makeTempDir("abs-outside-target");
    dirsToClean.push(dir, outsideDir);
    makeSourceFile(dir, "src/index.ts", "export function main() { return 42; }\n");
    makeSourceFile(outsideDir, "src/external.ts", "export const external: number = 1;\n");
    await ensureProjectDocsInitialized(dir);

    const outsidePath = join(outsideDir, "src", "external.ts");
    queueDocUpdate(outsidePath, "write", dir);

    const ctx = makePluginContext(dir);
    await flushDocUpdates(ctx, dir);

    const sm = readDocIfExists(dir, "SYSTEM_MAP.md");
    assert.ok(!sm.includes("external.ts"), "external file from outside project should NOT appear in SYSTEM_MAP");
  });
});

// =====================================================
// maxChangelogEntriesPerSession — multi-flush cap
// =====================================================
describe("maxChangelogEntriesPerSession — multi-flush cap", () => {
  it("enforces cap across multiple flushes (30+25)", async () => {
    const dir = makeTempDir("cap-multiflush");
    dirsToClean.push(dir);
    for (let i = 0; i < 30; i++) {
      makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dir);
    }
    const ctx = makeCapContext(dir, 10000, 50);
    resetSessionFlushState(dir);
    await flushDocUpdates(ctx, dir);
    assert.equal(countFileRefs(dir, "src/f"), 30, "first flush should write 30 entries");

    for (let i = 30; i < 55; i++) {
      makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dir);
    }
    await flushDocUpdates(ctx, dir);
    assert.equal(countFileRefs(dir, "src/f"), 50, "second flush should cap at 50 total");
    assert.ok(!readDocIfExists(dir, "CHANGELOG_LIVE.md").includes("f50"), "f50 should be suppressed");
    assert.ok(!readDocIfExists(dir, "CHANGELOG_LIVE.md").includes("f54"), "f54 should be suppressed");
  });
});

// =====================================================
// maxChangelogEntriesPerSession — project isolation
// =====================================================
describe("maxChangelogEntriesPerSession — project isolation", () => {
  it("cap is per-project, not global", async () => {
    const dirA = makeTempDir("cap-iso-a");
    const dirB = makeTempDir("cap-iso-b");
    dirsToClean.push(dirA, dirB);

    for (let i = 0; i < 50; i++) {
      makeSourceFile(dirA, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dirA);
    }
    const ctxA = makeCapContext(dirA, 10000, 50);
    resetSessionFlushState(dirA);
    await flushDocUpdates(ctxA, dirA);
    assert.equal(countFileRefs(dirA, "src/f"), 50, "project A should have 50 entries");

    for (let i = 0; i < 5; i++) {
      makeSourceFile(dirB, `src/g${i}.ts`, `export const g${i}: number = ${i};\n`);
      queueDocUpdate(`src/g${i}.ts`, "write", dirB);
    }
    const ctxB = makeCapContext(dirB, 10000, 50);
    resetSessionFlushState(dirB);
    await flushDocUpdates(ctxB, dirB);
    assert.equal(countFileRefs(dirB, "src/g"), 5, "project B should have 5 entries (unaffected by A's cap)");
  });
});

// =====================================================
// maxChangelogEntriesPerSession — session reset
// =====================================================
describe("maxChangelogEntriesPerSession — session reset", () => {
  it("session reset preserves pending updates and resets counter", async () => {
    const dir = makeTempDir("cap-reset");
    dirsToClean.push(dir);
    for (let i = 0; i < 50; i++) {
      makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dir);
    }
    const ctx = makeCapContext(dir, 10000, 50);
    resetSessionFlushState(dir);
    await flushDocUpdates(ctx, dir);
    assert.equal(countFileRefs(dir, "src/f"), 50, "cap reached after first flush");

    makeSourceFile(dir, "src/f50.ts", "export const f50: number = 50;\n");
    queueDocUpdate("src/f50.ts", "write", dir);
    assert.ok(getPendingUpdates(dir).length > 0, "f50 should be pending before reset");

    resetSessionFlushState(dir);
    assert.ok(getPendingUpdates(dir).length > 0, "pending should survive session reset");

    await flushDocUpdates(ctx, dir);
    assert.ok(readDocIfExists(dir, "CHANGELOG_LIVE.md").includes("f50"), "f50 should be written after reset");
  });
});

// =====================================================
// maxChangelogEntriesPerSession — concurrent flush
// =====================================================
describe("maxChangelogEntriesPerSession — concurrent flush", () => {
  it("concurrent same-project flush never exceeds cap", async () => {
    const dir = makeTempDir("cap-concurrent");
    dirsToClean.push(dir);
    for (let i = 0; i < 30; i++) {
      makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dir);
    }
    const ctx = makeCapContext(dir, 10000, 50);
    resetSessionFlushState(dir);
    const flush1 = flushDocUpdates(ctx, dir);

    for (let i = 30; i < 55; i++) {
      makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dir);
    }
    const flush2 = flushDocUpdates(ctx, dir);

    await Promise.all([flush1, flush2]);
    assert.equal(countFileRefs(dir, "src/f"), 50, "concurrent flushes must not exceed cap");
  });
});

// =====================================================
// maxChangelogEntriesPerSession — race-safe reset
// =====================================================
describe("maxChangelogEntriesPerSession — race-safe reset", () => {
  it("reset during in-flight flush does not consume new session allowance", async () => {
    const dir = makeTempDir("cap-race");
    dirsToClean.push(dir);
    const ctx = makeCapContext(dir, 10000, 50);
    resetSessionFlushState(dir);
    for (let i = 0; i < 50; i++) {
      makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
      queueDocUpdate(`src/f${i}.ts`, "write", dir);
    }
    const originalMkdir = fs.mkdir;
    const enteredIo = deferred<void>();
    const releaseIo = deferred<void>();
    let firstCall = true;
    fs.mkdir = async function (...args: Parameters<typeof originalMkdir>) {
      if (firstCall) { firstCall = false; enteredIo.resolve(); await releaseIo.promise; }
      return originalMkdir.apply(fs, args);
    } as typeof originalMkdir;
    try {
      const flushA = flushDocUpdates(ctx, dir);
      await enteredIo.promise;
      for (let i = 50; i < 75; i++) {
        makeSourceFile(dir, `src/f${i}.ts`, `export const f${i}: number = ${i};\n`);
        queueDocUpdate(`src/f${i}.ts`, "write", dir);
      }
      const flushB = flushDocUpdates(ctx, dir);
      resetSessionFlushState(dir);
      releaseIo.resolve();
      await flushA;
      await flushB;
      makeSourceFile(dir, "src/f99.ts", "export const f99: number = 99;\n");
      queueDocUpdate("src/f99.ts", "write", dir);
      await flushDocUpdates(ctx, dir);
      assert.ok(readDocIfExists(dir, "CHANGELOG_LIVE.md").includes("f99"), "f99 should be written with full new-session allowance");
    } finally {
      releaseIo.resolve();
      fs.mkdir = originalMkdir;
    }
  });
});

// =====================================================
// maxChangelogEntriesPerSession — truncation-aware counting
// =====================================================
describe("maxChangelogEntriesPerSession — truncation-aware counting", () => {
  it("counter reflects rendered entries, not queued count", async () => {
    const dir = makeTempDir("cap-trunc");
    dirsToClean.push(dir);
    const ctx = makeCapContext(dir, 80, 10);
    resetSessionFlushState(dir);

    for (let i = 0; i < 15; i++) {
      const name = `src/long-name-${String(i).padStart(2, "0")}.tsx`;
      makeSourceFile(dir, name, `export const longName${i}: number = ${i};\n`);
      queueDocUpdate(name, "write", dir);
    }
    await flushDocUpdates(ctx, dir);
    const firstCount = countFileRefs(dir, "src/long-name");
    assert.ok(firstCount > 0, "at least one long-name entry should be rendered");
    assert.ok(firstCount < 10, "first flush should not reach cap with oversized entries");

    let total = firstCount;
    let idx = 0;
    while (total < 10 && idx < 20) {
      const name = `src/solo-${idx}.ts`;
      makeSourceFile(dir, name, "export const x: number = 0;\n");
      queueDocUpdate(name, "write", dir);
      await flushDocUpdates(ctx, dir);
      total = countFileRefs(dir, "src/long-name") + countFileRefs(dir, "src/solo-");
      idx++;
    }
    assert.equal(total, 10, "changelog should reach exactly 10 entries (the cap)");

    makeSourceFile(dir, "src/overflow.ts", "export const overflow: number = 1;\n");
    queueDocUpdate("src/overflow.ts", "write", dir);
    await flushDocUpdates(ctx, dir);
    const finalCount = countFileRefs(dir, "src/long-name") + countFileRefs(dir, "src/solo-") + countFileRefs(dir, "src/overflow");
    assert.equal(finalCount, 10, "cap should remain at 10 after overflow flush");
  });
});

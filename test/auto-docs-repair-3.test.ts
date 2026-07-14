import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  queueDocUpdate, flushDocUpdates, getPendingUpdates,
  resetSessionFlushState, ensureProjectDocsInitialized,
  invalidateProject, isProjectInitialized,
} from "../src/hooks/auto-docs.js";
import { reconcileSystemMap } from "../src/hooks/doc-analyzer.js";
import { scheduleDocFlushLocal, manualFlushProject } from "../src/hooks/tool-execute-memory.js";
import { dirsToClean, installAutoDocsTestHooks, makePluginContext, makeSourceFile, makeTempDir, readDocIfExists } from "./auto-docs-repair-fixture.js";

installAutoDocsTestHooks();

describe("auto-docs repair — concurrent init and queue-during-flush", () => {
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
    rmSync(changelogPath);
    mkdirSync(changelogPath);

    const ctx = makePluginContext(dir);
    const flushPromise = flushDocUpdates(ctx, dir);
    makeSourceFile(dir, "src/b.ts", "export const bValue: number = 200;\n");
    queueDocUpdate("src/b.ts", "write", dir);
    await flushPromise;

    const pending = getPendingUpdates(dir);
    assert.deepEqual(
      pending.map(update => update.filePath),
      ["src/a.ts", "src/b.ts"],
      "failed batch should be restored before newer queued updates",
    );
  });
});

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

describe("auto-docs repair — malformed heading and sibling rejection", () => {
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

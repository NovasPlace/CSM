import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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

describe("auto-docs repair — workfolder isolation", () => {
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

describe("auto-docs repair — timer isolation between workfolders", () => {
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

describe("auto-docs repair — idempotent init and document preservation", () => {
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

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  queueDocUpdate, flushDocUpdates, ensureProjectDocsInitialized,
  invalidateProject, isProjectInitialized,
} from "../src/hooks/auto-docs.js";
import { dirsToClean, installAutoDocsTestHooks, makePluginContext, makeSourceFile, makeTempDir, readDocIfExists } from "./auto-docs-repair-fixture.js";

installAutoDocsTestHooks();

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

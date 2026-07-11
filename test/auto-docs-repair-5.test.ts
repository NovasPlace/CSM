import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  queueDocUpdate, flushDocUpdates, ensureProjectDocsInitialized,
} from "../src/hooks/auto-docs.js";
import { dirsToClean, installAutoDocsTestHooks, makePluginContext, makeSourceFile, makeTempDir, readDocIfExists } from "./auto-docs-repair-fixture.js";

installAutoDocsTestHooks();

describe("auto-docs repair — subconscious README paths", () => {
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

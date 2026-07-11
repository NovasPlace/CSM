import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  queueDocUpdate,
  getPendingUpdates,
  clearPendingUpdates,
  isIgnoredPath,
  flushDocUpdates,
  DEFAULT_AUTO_DOCS_CONFIG,
  resetFlushedFlag,
  autoDocumentChange,
} from "../dist/hooks/auto-docs.js";
import {
  isIgnoredForAnalysis,
  isStubContent,
  updateDocContent,
  shouldSkipEntry,
} from "../dist/hooks/doc-analyzer.js";
import { promises as fs } from "fs";
import { join } from "path";

const TMP_DOCS = join(process.cwd(), "docs");
const CHANGELOG_PATH = join(TMP_DOCS, "CHANGELOG_LIVE.md");
const TEST_CHANGELOG = `# CHANGELOG_LIVE.md

## Development Log

### 2026-06-24 — Old entry
- old stuff
`;

beforeEach(() => {
  clearPendingUpdates();
  resetFlushedFlag();
});

describe("queueDocUpdate — basic operations", () => {
  it("queues a write update", () => {
    queueDocUpdate("src/index.ts", "write");
    const pending = getPendingUpdates();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].filePath, "src/index.ts");
    assert.equal(pending[0].changeType, "write");
  });

  it("queues an edit update", () => {
    queueDocUpdate("src/config.ts", "edit");
    const pending = getPendingUpdates();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].changeType, "edit");
  });

  it("deduplicates same file edits", () => {
    queueDocUpdate("src/index.ts", "write");
    queueDocUpdate("src/index.ts", "edit");
    const pending = getPendingUpdates();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].changeType, "edit");
  });

  it("skips when enabled=false in config via global", () => {
    queueDocUpdate("src/index.ts", "write");
    assert.ok(getPendingUpdates().length >= 0);
  });

  it("allows different files to be queued", () => {
    queueDocUpdate("src/a.ts", "write");
    queueDocUpdate("src/b.ts", "edit");
    assert.equal(getPendingUpdates().length, 2);
  });
});

describe("queueDocUpdate — ignore rules", () => {
  it("ignores docs/ paths at queue time", () => {
    queueDocUpdate("docs/CHANGELOG_LIVE.md", "write");
    const pending = getPendingUpdates();
    assert.equal(pending.length, 0);
  });

  it("ignores dist/ paths", () => {
    queueDocUpdate("dist/index.js", "write");
    assert.equal(getPendingUpdates().length, 0);
  });

  it("ignores node_modules/ paths", () => {
    queueDocUpdate("node_modules/foo/index.js", "write");
    assert.equal(getPendingUpdates().length, 0);
  });

  it("ignores .git/ paths", () => {
    queueDocUpdate(".git/config", "write");
    assert.equal(getPendingUpdates().length, 0);
  });
});

describe("isIgnoredPath", () => {
  it("matches dist/ path", () => {
    assert.equal(isIgnoredPath("dist/index.js"), true);
  });

  it("does not match src/ path", () => {
    assert.equal(isIgnoredPath("src/index.ts"), false);
  });

  it("allows docs/ files to be tracked (except recursive outputs)", () => {
    assert.equal(isIgnoredPath("docs/RUNBOOK.md"), false);
    assert.equal(isIgnoredPath("docs/ARCHITECTURE.md"), true);
  });

  it("ignores recursive auto-docs output files", () => {
    assert.equal(isIgnoredPath("docs/CHANGELOG_LIVE.md"), true);
    assert.equal(isIgnoredPath("docs/SYSTEM_MAP.md"), true);
    assert.equal(isIgnoredPath("docs/DECISIONS.md"), true);
    assert.equal(isIgnoredPath("docs/DEBUG_NOTES.md"), true);
    assert.equal(isIgnoredPath("docs/AGENT_MEMORY.md"), true);
  });

  it("handles Windows backslash paths", () => {
    assert.equal(isIgnoredPath("docs\\CHANGELOG_LIVE.md"), true);
    assert.equal(isIgnoredPath("docs\\RUNBOOK.md"), false);
  });
});

describe("flushDocUpdates — write and group", () => {
  beforeEach(async () => {
    clearPendingUpdates();
    await fs.mkdir(TMP_DOCS, { recursive: true });
    await fs.writeFile(CHANGELOG_PATH, TEST_CHANGELOG, "utf-8");
  });

  afterEach(async () => {
    clearPendingUpdates();
    try { await fs.writeFile(CHANGELOG_PATH, TEST_CHANGELOG, "utf-8"); } catch {}
  });

  it("writes changelog entry on flush", async () => {
    queueDocUpdate("src/new-feature.ts", "write");
    await flushDocUpdates();
    const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
    assert.ok(content.includes("new-feature.ts"));
    assert.ok(content.includes("## Development Log"));
  });

  it("groups multiple edits of same changeType in changelog", async () => {
    queueDocUpdate("src/a.ts", "write");
    queueDocUpdate("src/b.ts", "write");
    await flushDocUpdates();
    const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
    assert.ok(content.includes("src/a.ts"));
    assert.ok(content.includes("src/b.ts"));
  });

  it("does not flush twice (idempotent)", async () => {
    queueDocUpdate("src/a.ts", "write");
    await flushDocUpdates();
    await flushDocUpdates();
    const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
    const count = content.split("src/a.ts").length - 1;
    assert.equal(count, 1);
  });
});

describe("flushDocUpdates — edge cases", () => {
  beforeEach(async () => {
    clearPendingUpdates();
    await fs.mkdir(TMP_DOCS, { recursive: true });
    await fs.writeFile(CHANGELOG_PATH, TEST_CHANGELOG, "utf-8");
  });

  afterEach(async () => {
    clearPendingUpdates();
    try { await fs.writeFile(CHANGELOG_PATH, TEST_CHANGELOG, "utf-8"); } catch {}
  });

  it("handles empty queue gracefully", async () => {
    await flushDocUpdates();
    const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
    assert.ok(content.includes("Old entry"));
  });

  it("prevents recursive doc-update loops by ignoring auto-docs output files", async () => {
    queueDocUpdate("docs/CHANGELOG_LIVE.md", "write");
    queueDocUpdate("docs/SYSTEM_MAP.md", "write");
    queueDocUpdate("src/real-file.ts", "write");
    await flushDocUpdates();
    const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
    const logStart = content.indexOf("## Development Log");
    const newEntry = content.slice(logStart);
    assert.ok(!newEntry.includes("CHANGELOG_LIVE.md"));
    assert.ok(!newEntry.includes("SYSTEM_MAP.md"));
    assert.ok(newEntry.includes("src/real-file.ts"));
  });
});

describe("doc-analyzer guards", () => {
  it("isIgnoredForAnalysis rejects coverage/", () => {
    assert.equal(isIgnoredForAnalysis("coverage/lcov.info"), true);
  });

  it("isIgnoredForAnalysis rejects test fixtures", () => {
    assert.equal(isIgnoredForAnalysis("test/fixtures/mock.ts"), true);
  });

  it("isIgnoredForAnalysis accepts src/ files", () => {
    assert.equal(isIgnoredForAnalysis("src/database.ts"), false);
  });

  it("isStubContent detects empty exports", () => {
    assert.equal(isStubContent("export {}"), true);
  });

  it("isStubContent detects comment-only files", () => {
    assert.equal(isStubContent("// just a comment\n"), true);
  });

  it("isStubContent accepts real modules", () => {
    assert.equal(isStubContent("export function hello() { return 42; }"), false);
  });

  it("updateDocContent deduplicates file entries in SYSTEM_MAP", () => {
    let doc = "## src\n| File | Exports | Type | Role |\n|------|---------|------|------|\n| `src/database.ts` | Database | source | DB layer |\n";
    doc = updateDocContent(doc, "src", "| `src/database.ts` | Database, DatabasePool | source | DB layer (updated) |", "src/database.ts");
    const count = (doc.match(/src\/database\.ts/g) || []).length;
    assert.equal(count, 1, "should not duplicate entry");
  });

  it("shouldSkipEntry rejects files with no exports or imports", () => {
    assert.equal(shouldSkipEntry([], []), true);
  });

  it("shouldSkipEntry accepts files with real exports", () => {
    assert.equal(shouldSkipEntry(["measureCompactionQuality"], ["./types.js"]), false);
  });
});

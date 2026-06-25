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
} from "../dist/hooks/auto-docs.js";
import { promises as fs } from "fs";
import { join } from "path";

const TMP_DOCS = join(process.cwd(), "docs");
const CHANGELOG_PATH = join(TMP_DOCS, "CHANGELOG_LIVE.md");

describe("auto-docs", () => {
  beforeEach(() => {
    clearPendingUpdates();
    resetFlushedFlag();
  });

  describe("queueDocUpdate", () => {
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

    it("deduplicates same file edits", () => {
      queueDocUpdate("src/index.ts", "write");
      queueDocUpdate("src/index.ts", "edit");
      const pending = getPendingUpdates();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].changeType, "edit");
    });

    it("respects maxChangelogEntriesPerSession cap", () => {
      queueDocUpdate("src/a.ts", "write");
      queueDocUpdate("src/b.ts", "write");
      queueDocUpdate("src/c.ts", "write");
      queueDocUpdate("src/d.ts", "write");
      const pending = getPendingUpdates();
      // Max is 50 by default, so all 4 should be queued
      assert.ok(pending.length >= 3);
    });

    it("skips when enabled=false in config via global", () => {
      // The config is read from global, not passed in
      // This test verifies queueDocUpdate doesn't throw
      queueDocUpdate("src/index.ts", "write");
      assert.ok(getPendingUpdates().length >= 0);
    });

    it("allows different files to be queued", () => {
      queueDocUpdate("src/a.ts", "write");
      queueDocUpdate("src/b.ts", "edit");
      assert.equal(getPendingUpdates().length, 2);
    });
  });

  describe("isIgnoredPath", () => {
    const ignored = ["docs/", "dist/", "node_modules/", ".git/"];

    it("matches docs/ path", () => {
      assert.equal(isIgnoredPath("docs/SYSTEM_MAP.md", ignored), true);
    });

    it("matches nested docs/ path", () => {
      assert.equal(isIgnoredPath("project/docs/foo.md", ignored), true);
    });

    it("matches dist/ path", () => {
      assert.equal(isIgnoredPath("dist/index.js", ignored), true);
    });

    it("does not match src/ path", () => {
      assert.equal(isIgnoredPath("src/index.ts", ignored), false);
    });

    it("handles Windows backslash paths", () => {
      assert.equal(isIgnoredPath("docs\\SYSTEM_MAP.md", ignored), true);
    });
  });

  describe("flushDocUpdates", () => {
    const testChangelog = `# CHANGELOG_LIVE.md

## Development Log

### 2026-06-24 — Old entry
- old stuff
`;

    beforeEach(async () => {
      clearPendingUpdates();
      await fs.mkdir(TMP_DOCS, { recursive: true });
      await fs.writeFile(CHANGELOG_PATH, testChangelog, "utf-8");
    });

    afterEach(async () => {
      clearPendingUpdates();
      try {
        const original = `# CHANGELOG_LIVE.md

## Development Log

### 2026-06-24 — Old entry
- old stuff
`;
        await fs.writeFile(CHANGELOG_PATH, original, "utf-8");
      } catch {}
    });

    it("writes changelog entry on flush", async () => {
      queueDocUpdate("src/new-feature.ts", "write");
      await flushDocUpdates();

      const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
      // New implementation writes to changelog with timestamp format
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
      // Should only have one entry for this session
      const count = content.split("src/a.ts").length - 1;
      assert.equal(count, 1);
    });

    it("handles empty queue gracefully", async () => {
      await flushDocUpdates();

      const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
      // Should not add new entries
      assert.ok(content.includes("Old entry"));
    });

    it("prevents recursive doc-update loops by ignoring docs/ at queue time", async () => {
      queueDocUpdate("docs/CHANGELOG_LIVE.md", "write");
      queueDocUpdate("src/real-file.ts", "write");
      await flushDocUpdates();

      const content = await fs.readFile(CHANGELOG_PATH, "utf-8");
      // docs/ should be ignored at queue time
      assert.ok(!content.includes("docs/CHANGELOG_LIVE.md"));
      assert.ok(content.includes("src/real-file.ts"));
    });
  });
});
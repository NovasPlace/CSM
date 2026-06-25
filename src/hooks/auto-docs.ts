import { PluginContext } from "../plugin-context.js";
import { promises as fs } from "fs";
import { join, normalize, sep } from "path";
import { autoDocumentChange } from "./doc-analyzer.js";

export const DEFAULT_AUTO_DOCS_CONFIG = {
  enabled: true,
  ignoredPaths: ["docs/", "dist/", "node_modules/", "coverage/", ".git/"],
  maxChangelogEntriesPerSession: 50,
  maxEntryLength: 200,
  deduplicateEdits: true,
  groupMultipleEdits: true,
  dedupWindowMs: 5000,
} as const;

interface PendingDocUpdate {
  filePath: string;
  changeType: "write" | "edit" | "delete";
  timestamp: Date;
}

const pendingUpdates: PendingDocUpdate[] = [];
let flushed = false;

export function queueDocUpdate(
  filePath: string,
  changeType: "write" | "edit" | "delete"
): void {
  if (isIgnoredPath(filePath)) return;
  const existing = pendingUpdates.find(u => u.filePath === filePath);
  if (existing) {
    existing.changeType = changeType;
    existing.timestamp = new Date();
  } else {
    pendingUpdates.push({ filePath, changeType, timestamp: new Date() });
  }
}

export function isIgnoredPath(filePath: string): boolean {
  const normalized = normalize(filePath);
  const ignoredPatterns = [
    "docs/",
    "dist/",
    "node_modules/",
    "coverage/",
    ".git/",
    "*.log",
    "*.tmp",
  ];
  return ignoredPatterns.some(pattern => {
    if (pattern.endsWith("/")) {
      return normalized.includes(pattern.replace("/", sep));
    }
    if (pattern.startsWith("*.")) {
      return normalized.endsWith(pattern.slice(1));
    }
    return normalized.includes(pattern);
  });
}

export async function flushDocUpdates(context?: PluginContext): Promise<void> {
  if (flushed) return;
  if (pendingUpdates.length === 0) return;

  const config = context?.config?.autoDocs ?? {
    maxEntryLength: 500,
    maxChangelogEntriesPerSession: 50,
    deduplicateEdits: true,
    groupMultipleEdits: true,
  };
  const docsDir = join(process.cwd(), "docs");

  try {
    await fs.mkdir(docsDir, { recursive: true });

    for (const update of pendingUpdates) {
      let content = "";
      try {
        content = await fs.readFile(update.filePath, "utf-8");
      } catch {
        content = "";
      }
      await autoDocumentChange(update.filePath, update.changeType, undefined, content);
    }

    let existing = "";
    const changelogPath = join(docsDir, "CHANGELOG_LIVE.md");
    try {
      existing = await fs.readFile(changelogPath, "utf-8");
    } catch {
      existing = "# CHANGELOG_LIVE.md\n\n## Development Log\n\n";
    }

    const entry = buildChangelogEntry(pendingUpdates, config.maxEntryLength);
    if (entry) {
      const headerEnd = existing.indexOf("## Development Log");
      if (headerEnd === -1) {
        existing = `# CHANGELOG_LIVE.md\n\n## Development Log\n\n${existing}`;
      }
      const insertPoint = existing.indexOf("\n", headerEnd + "## Development Log".length) + 1;
      const updated = existing.slice(0, insertPoint) + "\n" + entry + existing.slice(insertPoint);
      await fs.writeFile(changelogPath, updated, "utf-8");
    }
  } catch (err) {
    console.error("[auto-docs] flush error:", err);
  }

  flushed = true;
  pendingUpdates.length = 0;
}

function buildChangelogEntry(updates: PendingDocUpdate[], maxLength: number): string {
  if (updates.length === 0) return "";
  
  const byType = new Map<string, Set<string>>();
  for (const u of updates) {
    const set = byType.get(u.changeType) ?? new Set();
    set.add(u.filePath);
    byType.set(u.changeType, set);
  }

  const parts: string[] = [];
  for (const [type, files] of byType.entries()) {
    parts.push(`${type}: ${Array.from(files).join(", ")}`);
  }

  let entry = `### ${new Date().toISOString().split("T")[0]} — Auto-documented changes\n`;
  entry += `- ${parts.join("; ")}\n`;
  
  if (entry.length > maxLength) {
    entry = entry.slice(0, maxLength - 3) + "...";
  }
  return entry;
}

export function clearPendingUpdates(): void {
  pendingUpdates.length = 0;
}

export function getPendingUpdates(): PendingDocUpdate[] {
  return [...pendingUpdates];
}

export function resetFlushedFlag(): void {
  flushed = false;
}


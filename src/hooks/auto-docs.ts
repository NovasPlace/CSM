import { PluginContext } from "../plugin-context.js";
import { promises as fs } from "fs";
import { join, normalize, sep } from "path";

interface PendingDocUpdate {
  filePath: string;
  changeType: "write" | "edit" | "delete";
  timestamp: Date;
}

const pendingUpdates: PendingDocUpdate[] = [];
let flushed = false;

const DEFAULT_AUTO_DOCS_CONFIG = {
  enabled: true,
  ignoredPaths: ["docs/", "dist/", "node_modules/", "coverage/", ".git/"],
  maxChangelogEntriesPerSession: 50,
  maxEntryLength: 500,
  deduplicateEdits: true,
  groupMultipleEdits: true,
};

function getConfig(context?: PluginContext): typeof DEFAULT_AUTO_DOCS_CONFIG {
  const pluginConfig = (context as any)?.config?.autoDocs;
  if (!pluginConfig) return DEFAULT_AUTO_DOCS_CONFIG;
  return { ...DEFAULT_AUTO_DOCS_CONFIG, ...pluginConfig };
}

function isIgnoredPath(filePath: string, ignoredPaths: string[]): boolean {
  const normalized = normalize(filePath).replace(/\\/g, "/");
  return ignoredPaths.some(
    (p) => normalized.includes(p.replace(/\\/g, "/"))
  );
}

export function queueDocUpdate(
  filePath: string,
  changeType: "write" | "edit" | "delete",
  context?: PluginContext
): void {
  const config = getConfig(context);

  if (!config.enabled) return;

  if (isIgnoredPath(filePath, config.ignoredPaths)) return;

  if (flushed) {
    flushed = false;
  }

  if (config.deduplicateEdits) {
    const existingIdx = pendingUpdates.findIndex(
      (u) => u.filePath === filePath
    );
    if (existingIdx !== -1) {
      pendingUpdates[existingIdx].changeType = changeType;
      pendingUpdates[existingIdx].timestamp = new Date();
      return;
    }
  }

  if (
    pendingUpdates.length >= config.maxChangelogEntriesPerSession
  ) {
    return;
  }

  pendingUpdates.push({ filePath, changeType, timestamp: new Date() });
}

export function getPendingUpdates(): PendingDocUpdate[] {
  return [...pendingUpdates];
}

export function clearPendingUpdates(): void {
  pendingUpdates.length = 0;
  flushed = false;
}

function truncateEntry(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + "...";
}

function buildChangelogEntry(
  updates: PendingDocUpdate[],
  maxEntryLength: number
): string {
  const date = new Date().toISOString().split("T")[0];
  const lines: string[] = [];

  if (updates.length === 0) return "";

  if (updates.length === 1) {
    const u = updates[0];
    const line = `- **${u.changeType}**: \`${u.filePath}\``;
    lines.push(truncateEntry(line, maxEntryLength));
  } else {
    const grouped = new Map<string, string[]>();
    for (const u of updates) {
      const key = u.changeType;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(u.filePath);
    }
    for (const [changeType, files] of grouped) {
      const fileList = files.map((f) => `\`${f}\``).join(", ");
      const line = `- **${changeType}**: ${fileList}`;
      lines.push(truncateEntry(line, maxEntryLength));
    }
  }

  return `### ${date} — Auto-Documented\n${lines.join("\n")}\n`;
}

export async function flushDocUpdates(context?: PluginContext): Promise<void> {
  if (flushed) return;
  if (pendingUpdates.length === 0) return;

  const config = getConfig(context);
  const docsDir = join(process.cwd(), "docs");
  const changelogPath = join(docsDir, "CHANGELOG_LIVE.md");

  try {
    await fs.mkdir(docsDir, { recursive: true });

    let existing = "";
    try {
      existing = await fs.readFile(changelogPath, "utf-8");
    } catch {
      existing = "# CHANGELOG_LIVE.md\n\n## Development Log\n\n";
    }

    const entry = buildChangelogEntry(pendingUpdates, config.maxEntryLength);
    if (!entry) return;

    const headerEnd = existing.indexOf("## Development Log");
    if (headerEnd === -1) {
      existing = `# CHANGELOG_LIVE.md\n\n## Development Log\n\n${existing}`;
    }

    const insertPoint = existing.indexOf("\n", headerEnd + "## Development Log".length) + 1;
    const updated =
      existing.slice(0, insertPoint) + "\n" + entry + existing.slice(insertPoint);

    await fs.writeFile(changelogPath, updated, "utf-8");
  } catch (err) {
    console.error("[auto-docs] flush error:", err);
  }

  flushed = true;
  pendingUpdates.length = 0;
}

export { isIgnoredPath, getConfig, DEFAULT_AUTO_DOCS_CONFIG };

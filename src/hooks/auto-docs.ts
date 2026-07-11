import { PluginContext } from "../plugin-context.js";
import { promises as fs } from "fs";
import { join, isAbsolute, relative } from "path";
import { autoDocumentChange, reconcileSystemMap, initializeDocsForProject } from "./doc-analyzer.js";
import { reconcileArchitectureDoc } from "./architecture-doc.js";
import { getLogger } from "../logger.js";
import { projectKey, resolveProjectFile } from "./doc-project-key.js";

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

// Per-workfolder pending updates — keyed by projectKey(projectDir)
const pendingUpdatesByKey = new Map<string, PendingDocUpdate[]>();

// Per-workfolder initialization state — keyed by projectKey(projectDir)
const initializedProjects = new Set<string>();

// Per-workfolder in-flight initialization Promise — prevents concurrent init of same folder
const inflightInitByKey = new Map<string, Promise<void>>();

// Per-workfolder invalidation generation — bumped on invalidateProject().
// An in-flight init started before invalidation must not mark the project
// initialized after it resolves, because the generation will have advanced.
const projectGenerationByKey = new Map<string, number>();

// Per-workfolder changelog session state — keyed by projectKey(projectDir).
// Uses replaceable state objects so that resetSessionFlushState() can swap
// the entry without affecting in-flight flushes that captured the old object.
interface ChangelogSessionState {
  written: number;
}
const changelogSessionStateByKey = new Map<string, ChangelogSessionState>();

// Per-workfolder in-flight flush Promise — serializes concurrent flushes
// of the same workfolder so the counter check, changelog read/write, and
// increment happen atomically per project.
const inflightFlushByKey = new Map<string, Promise<void>>();

function getChangelogSessionState(key: string): ChangelogSessionState {
  let state = changelogSessionStateByKey.get(key);
  if (!state) {
    state = { written: 0 };
    changelogSessionStateByKey.set(key, state);
  }
  return state;
}

let autoDocsEnabled = true;

export function setAutoDocsEnabled(enabled: boolean): void {
  autoDocsEnabled = enabled;
}

/**
 * Queue a document update for the given file change.
 *
 * `projectDir` is optional ONLY for backward-compatibility with existing
 * test callers. All internal callers MUST pass the workfolder directory;
 * omitting it defaults to `process.cwd()` which is a backward-compat shim.
 */
export function queueDocUpdate(
  filePath: string,
  changeType: "write" | "edit" | "delete",
  projectDir?: string,
): void {
  if (!autoDocsEnabled) return;
  if (isIgnoredPath(filePath)) return;
  const key = projectKey(projectDir ?? process.cwd());
  // Normalize absolute paths to project-relative for consistent SYSTEM_MAP entries.
  // This prevents the same file appearing under both absolute and relative identities.
  let normalized = filePath.replace(/\\/g, "/");
  if (isAbsolute(filePath) && projectDir) {
    const rel = relative(projectDir, filePath).replace(/\\/g, "/");
    if (rel.startsWith("..") || isAbsolute(rel)) {
      // Path is outside project — reject it
      getLogger().warn(`flushDocUpdates: skipping path outside workspace: ${filePath}`);
      return;
    }
    normalized = rel;
  }
  const bucket = pendingUpdatesByKey.get(key) ?? [];
  const existing = bucket.find(u => u.filePath === normalized);
  if (existing) {
    existing.changeType = changeType;
    existing.timestamp = new Date();
  } else {
    bucket.push({ filePath: normalized, changeType, timestamp: new Date() });
  }
  pendingUpdatesByKey.set(key, bucket);
}

export function isIgnoredPath(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, "/");
    const ignoredPatterns = [
      "dist/",
      "node_modules/",
      "coverage/",
      ".git/",
      "*.log",
      "*.tmp",
    ];
    // Prevent recursive loops: ignore the files auto-docs itself writes to
    const recursivePaths = [
      "ARCHITECTURE.md",
      "CHANGELOG_LIVE.md",
      "SYSTEM_MAP.md",
      "DECISIONS.md",
      "DEBUG_NOTES.md",
      "AGENT_MEMORY.md",
    ];
    const baseName = normalized.split("/").pop() || "";
    if (recursivePaths.includes(baseName)) return true;
    return ignoredPatterns.some(pattern => {
      if (pattern.endsWith("/")) {
        return normalized.includes(pattern);
      }
      if (pattern.startsWith("*.")) {
        return normalized.endsWith(pattern.slice(1));
      }
      return normalized.includes(pattern);
    });
  }

/**
 * Flush pending doc updates for a specific workfolder.
 *
 * The current bucket is **detached before awaiting** so that updates queued
 * while the flush is in-flight enter a fresh bucket. If the flush fails,
 * the detached batch is restored without overwriting newer updates.
 */
export async function flushDocUpdates(context?: PluginContext, workspaceDir?: string): Promise<void> {
  const projectDir = workspaceDir ?? context?.directory ?? process.cwd();
  const key = projectKey(projectDir);

  // Detach the current bucket before any await — new updates go to a new bucket
  const batch = pendingUpdatesByKey.get(key) ?? [];
  pendingUpdatesByKey.delete(key);
  if (batch.length === 0) return;

  const config = context?.config?.autoDocs ?? {
    maxEntryLength: 500,
    maxChangelogEntriesPerSession: 50,
    deduplicateEdits: true,
    groupMultipleEdits: true,
  };
  const docsDir = join(projectDir, "docs");

  // Capture the session state BEFORE registering/waiting on the serialization
  // chain. This binds each detached batch to the session in which that flush
  // began. An old-session flush that is still waiting behind another old-session
  // flush will have already captured the old state object; a reset during the
  // wait replaces the Map entry, so the old flush increments the orphaned object
  // and cannot consume the new session's allowance.
  const sessionState = getChangelogSessionState(key);

  // Serialize concurrent flushes of the same workfolder so the counter check,
  // changelog read/write, and increment happen atomically per project.
  const prevFlush = inflightFlushByKey.get(key) ?? Promise.resolve();
  let resolveFlush!: () => void;
  const flushPromise = new Promise<void>(r => { resolveFlush = r; });
  inflightFlushByKey.set(key, flushPromise);

  try {
    await prevFlush.catch(() => {});

    await fs.mkdir(docsDir, { recursive: true });
    const documentedUpdates: PendingDocUpdate[] = [];

    for (const update of batch) {
      const resolvedPath = resolveProjectFile(projectDir, update.filePath);
      if (!resolvedPath) {
        getLogger().warn(`flushDocUpdates: skipping path outside workspace: ${update.filePath}`);
        continue;
      }
      documentedUpdates.push(update);
      let content = "";
      try {
        content = await fs.readFile(resolvedPath, "utf-8");
      } catch {
        content = "";
      }
      await autoDocumentChange(update.filePath, update.changeType, undefined, content, projectDir);
    }

    let existing = "";
    const changelogPath = join(docsDir, "CHANGELOG_LIVE.md");
    try {
      existing = await fs.readFile(changelogPath, "utf-8");
    } catch {
      existing = "# CHANGELOG_LIVE.md\n\n## Development Log\n\n";
    }

    const cap = config.maxChangelogEntriesPerSession ?? 50;
    const remaining = Math.max(0, cap - sessionState.written);
    const changelogUpdates = documentedUpdates.slice(0, remaining);
    const capSuppressedCount = documentedUpdates.length - changelogUpdates.length;

    if (changelogUpdates.length > 0) {
      const result = buildChangelogEntry(changelogUpdates, config.maxEntryLength);
      const lengthSuppressedCount = changelogUpdates.length - result.includedCount;

      if (result.content) {
        const headerEnd = existing.indexOf("## Development Log");
        if (headerEnd === -1) {
          existing = `# CHANGELOG_LIVE.md\n\n## Development Log\n\n${existing}`;
        }
        const insertPoint = existing.indexOf("\n", headerEnd + "## Development Log".length) + 1;
        const updated = existing.slice(0, insertPoint) + "\n" + result.content + existing.slice(insertPoint);
        await fs.writeFile(changelogPath, updated, "utf-8");
        sessionState.written += result.includedCount;
      }

      if (lengthSuppressedCount > 0) {
        getLogger().info(
          `[auto-docs] Omitted ${lengthSuppressedCount} changelog entries due to ` +
          `maxEntryLength (${config.maxEntryLength}) for ${projectDir}`,
        );
      }
    }

    if (capSuppressedCount > 0) {
      getLogger().info(
        `[auto-docs] Suppressed ${capSuppressedCount} changelog entries: ` +
        `session cap reached (${sessionState.written}/${cap}) for ${projectDir}`,
      );
    }
  } catch (err) {
    // Restore the detached batch WITHOUT overwriting newer updates queued during flush
    const currentBucket = pendingUpdatesByKey.get(key);
    if (currentBucket) {
      // Merge: restored batch entries first, then any newer entries
      const merged = [...batch];
      const existingPaths = new Set(batch.map(u => u.filePath));
      for (const u of currentBucket) {
        if (!existingPaths.has(u.filePath)) merged.push(u);
        else {
          // Replace the old entry with the newer one
          const idx = merged.findIndex(m => m.filePath === u.filePath);
          if (idx !== -1) merged[idx] = u;
        }
      }
      pendingUpdatesByKey.set(key, merged);
    } else {
      pendingUpdatesByKey.set(key, batch);
    }
    getLogger().error('[auto-docs] flush error', err instanceof Error ? err : new Error(String(err)));
    return;
  } finally {
    resolveFlush();
    if (inflightFlushByKey.get(key) === flushPromise) {
      inflightFlushByKey.delete(key);
    }
  }

  try {
    const reconResult = await reconcileSystemMap(docsDir, projectDir);
    if (reconResult.added > 0 || reconResult.updated > 0 || reconResult.removed > 0) {
      getLogger().info(`[auto-docs] SYSTEM_MAP reconciled: +${reconResult.added} ~${reconResult.updated} -${reconResult.removed}`);
    }
    const archResult = await reconcileArchitectureDoc(docsDir, projectDir);
    if (archResult.wrote) {
      getLogger().info(`[auto-docs] ARCHITECTURE refreshed: files=${archResult.fileCount} edges=${archResult.edgeCount}`);
    }
  } catch (err) {
    getLogger().error('[auto-docs] reconcile error', err instanceof Error ? err : new Error(String(err)));
  }
}

interface ChangelogEntryResult {
  content: string;
  includedCount: number;
}

function renderChangelogBlock(updates: PendingDocUpdate[]): string {
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
  return entry;
}

function buildChangelogEntry(updates: PendingDocUpdate[], maxLength: number): ChangelogEntryResult {
  if (updates.length === 0) return { content: "", includedCount: 0 };

  for (let count = updates.length; count >= 1; count--) {
    const rendered = renderChangelogBlock(updates.slice(0, count));
    if (rendered.length <= maxLength) {
      if (count < updates.length && rendered.length + 4 <= maxLength) {
        return { content: rendered.slice(0, -1) + " ...\n", includedCount: count };
      }
      return { content: rendered, includedCount: count };
    }
  }

  return { content: "", includedCount: 0 };
}

/**
 * Clear pending updates for a specific project, or all if no projectDir given.
 */
export function clearPendingUpdates(projectDir?: string): void {
  if (projectDir) {
    pendingUpdatesByKey.delete(projectKey(projectDir));
  } else {
    pendingUpdatesByKey.clear();
  }
}

/**
 * Get pending updates for a specific project, or all (flattened) if no projectDir given.
 */
export function getPendingUpdates(projectDir?: string): PendingDocUpdate[] {
  if (projectDir) {
    return [...(pendingUpdatesByKey.get(projectKey(projectDir)) ?? [])];
  }
  return [...Array.from(pendingUpdatesByKey.values()).flat()];
}

/**
 * Reset the session-level flush marker for a project, or all if no projectDir given.
 *
 * This resets ONLY the session-level "already flushed this session" state.
 * It does NOT clear pending document updates or cancel timers — those survive
 * session transitions so that unflushed work is not lost.
 *
 * For backward compatibility, the existing `resetFlushedFlag` alias is preserved
 * but now delegates to this function instead of clearing pending updates.
 */
export function resetSessionFlushState(projectDir?: string): void {
  if (projectDir) {
    changelogSessionStateByKey.set(projectKey(projectDir), { written: 0 });
  } else {
    changelogSessionStateByKey.clear();
  }
}

/**
 * Clear pending doc updates for a project, or all if no projectDir given.
 * This is the destructive clear that removes queued document updates.
 * Use `resetSessionFlushState` for session transitions that should preserve
 * pending work.
 */
export function clearPendingDocUpdates(projectDir?: string): void {
  clearPendingUpdates(projectDir);
}

/**
 * @deprecated Use `resetSessionFlushState` (preserves pending updates) or
 * `clearPendingDocUpdates` (destructive clear) depending on the use case.
 * The old behavior cleared pending updates; the new behavior only resets
 * session-level state, preserving unflushed work across session transitions.
 */
export function resetFlushedFlag(projectDir?: string): void {
  resetSessionFlushState(projectDir);
}

/**
 * Invalidate initialization state for a specific project directory.
 * Other active workfolders remain cached.
 *
 * Bumps the per-project generation so that any in-flight initialization
 * started before this call cannot mark the project initialized after it resolves.
 */
export function invalidateProject(projectDir: string): void {
  const key = projectKey(projectDir);
  const currentGen = projectGenerationByKey.get(key) ?? 0;
  projectGenerationByKey.set(key, currentGen + 1);
  initializedProjects.delete(key);
}

/**
 * Clear all initialized projects (for testing / full reset).
 */
export function resetInitializedProjects(): void {
  initializedProjects.clear();
  inflightInitByKey.clear();
  projectGenerationByKey.clear();
  changelogSessionStateByKey.clear();
  inflightFlushByKey.clear();
}

/**
 * Ensure docs are initialized for the given project directory.
 *
 * Uses a per-key in-flight Promise to serialize concurrent initialization
 * of the same workfolder. On failure, the project is removed from the
 * initialized set so that a retry is possible.
 *
 * An invalidation that occurs while initialization is in-flight will bump
 * the generation, causing the resolving init to skip marking the project
 * initialized. The in-flight init may still finish its file operations,
 * but it must not restore the initialized state.
 */
export async function ensureProjectDocsInitialized(projectDir: string): Promise<void> {
  const key = projectKey(projectDir);
  if (initializedProjects.has(key)) return;

  // If initialization is already in-flight for this key, await it
  const inflight = inflightInitByKey.get(key);
  if (inflight) {
    await inflight;
    // After awaiting, check if the project was actually marked initialized.
    // If invalidation occurred during the in-flight init, it won't be.
    return;
  }

  // Capture the generation at the start of initialization.
  // If invalidateProject() is called while init is running, the generation
  // will advance and this init must not mark the project as initialized.
  const generationAtStart = projectGenerationByKey.get(key) ?? 0;

  const initPromise = (async () => {
    try {
      await initializeDocsForProject(projectDir);
      // Only mark initialized if no invalidation occurred during init
      const currentGen = projectGenerationByKey.get(key) ?? 0;
      if (currentGen === generationAtStart) {
        initializedProjects.add(key);
        getLogger().info(`[auto-docs] Initialized docs for project: ${projectDir}`);
      } else {
        getLogger().info(`[auto-docs] Init completed but generation advanced (stale), not marking initialized: ${projectDir}`);
      }
    } catch (err) {
      initializedProjects.delete(key);
      getLogger().error(`[auto-docs] Failed to initialize docs for ${projectDir}`, err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      inflightInitByKey.delete(key);
    }
  })();

  inflightInitByKey.set(key, initPromise);
  await initPromise;
}

export function isProjectInitialized(projectDir: string): boolean {
  return initializedProjects.has(projectKey(projectDir));
}

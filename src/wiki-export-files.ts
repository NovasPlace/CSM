import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { renderLogEntry, type LogEntry, type RenderedNote } from './wiki-note-renderer.js';
import type { WikiExportManifest } from './wiki-export-types.js';

const MANIFEST_SCHEMA_VERSION = 1;

export function readManifest(manifestPath: string): WikiExportManifest | null {
  try {
    if (!existsSync(manifestPath)) return null;
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return isManifest(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isManifest(value: unknown): value is WikiExportManifest {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<WikiExportManifest>;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) return false;
  if (manifest.mode !== 'curated' && manifest.mode !== 'full') return false;
  if (typeof manifest.databaseManifest !== 'string') return false;
  if (!manifest.notes || typeof manifest.notes !== 'object' || Array.isArray(manifest.notes)) return false;
  return Object.values(manifest.notes).every(isManifestEntry);
}

function isManifestEntry(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const entry = value as { path?: unknown; contentHash?: unknown };
  return typeof entry.path === 'string' && typeof entry.contentHash === 'string';
}

export function writeManifest(manifestPath: string, manifest: WikiExportManifest): void {
  atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
}

export function writeNotes(outputDir: string, notes: RenderedNote[], paths: Set<string>): void {
  for (const note of notes) {
    if (!paths.has(note.path)) continue;
    atomicWrite(resolveOwnedPath(outputDir, note.path), note.content);
  }
}

export function pruneOwnedFiles(outputDir: string, paths: string[]): number {
  const resolved = paths.map(path => resolveOwnedPath(outputDir, path));
  let removed = 0;
  for (const path of resolved) {
    if (!existsSync(path)) continue;
    unlinkSync(path);
    removed++;
  }
  return removed;
}

export function resolveOwnedPath(outputDir: string, manifestPath: string): string {
  const windowsRoot = isWindowsPath(outputDir)
    || (!posix.isAbsolute(outputDir) && process.platform === 'win32');
  const pathApi = windowsRoot ? win32 : posix;
  const containsTraversal = manifestPath.split(/[\\/]/u).includes('..');

  if (
    !manifestPath
    || manifestPath.includes('\0')
    || containsTraversal
    || /^[A-Za-z]:/u.test(manifestPath)
    || win32.isAbsolute(manifestPath)
    || posix.isAbsolute(manifestPath)
  ) {
    throw new Error(`Unsafe wiki manifest path: ${manifestPath}`);
  }

  const root = pathApi.resolve(outputDir);
  const candidate = pathApi.resolve(root, manifestPath);
  const fromRoot = pathApi.relative(root, candidate);
  if (
    !fromRoot
    || fromRoot === '..'
    || fromRoot.startsWith(`..${pathApi.sep}`)
    || pathApi.isAbsolute(fromRoot)
  ) {
    throw new Error(`Unsafe wiki manifest path: ${manifestPath}`);
  }
  return candidate;
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\');
}

export function appendExportLog(outputDir: string, entry: LogEntry): void {
  const logPath = resolveOwnedPath(outputDir, 'log.md');
  const existing = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  atomicWrite(logPath, `${existing}${renderLogEntry(entry)}\n\n`);
}

function atomicWrite(filePath: string, content: string): void {
  const directory = dirname(filePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, content, 'utf8');
  renameSync(temporaryPath, filePath);
}

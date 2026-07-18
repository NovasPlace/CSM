import { join } from 'node:path';
import type { Database } from './database.js';
import { getLogger } from './logger.js';
import { appendExportLog, pruneOwnedFiles, readManifest, writeManifest, writeNotes } from './wiki-export-files.js';
import { buildExportPlan } from './wiki-export-plan.js';
import { renderSnapshotNotes } from './wiki-export-render.js';
import { collectSnapshot, computeDatabaseFingerprint } from './wiki-export-snapshot.js';
import type { ExportSnapshot } from './wiki-export-model.js';
import type { WikiExportManifest, WikiExportOptions, WikiExportResult } from './wiki-export-types.js';

const MANIFEST_FILENAME = '.csm-export.json';

export async function exportWiki(
  database: Database,
  options: WikiExportOptions,
): Promise<WikiExportResult> {
  const mode = options.mode ?? 'curated';
  const threshold = options.importanceThreshold ?? 0.5;
  validateOptions(mode, threshold, options.outputDir);
  const manifestPath = join(options.outputDir, MANIFEST_FILENAME);
  const existing = options.incremental === false ? null : readManifest(manifestPath);
  const snapshot = await readSnapshot(database, {
    mode,
    importanceThreshold: threshold,
    includeLinked: options.includeLinked ?? true,
    projectId: options.projectId,
    memoryTypesFilter: options.memoryTypes,
  });
  const fingerprint = computeDatabaseFingerprint(snapshot);
  const dryRun = options.dryRun ?? false;
  const notes = renderSnapshotNotes(snapshot, threshold);
  const plan = buildExportPlan(notes, existing, options.prune ?? false);
  if (dryRun) return planResult(mode, snapshot, plan, fingerprint, true, options.outputDir);
  const writablePaths = new Set([...plan.create, ...plan.update]);
  writeNotes(options.outputDir, notes, writablePaths);
  const removed = pruneOwnedFiles(options.outputDir, plan.remove);
  appendExportLog(options.outputDir, buildLogEntry(mode, plan, removed, snapshot.memories.length));
  writeManifest(manifestPath, buildManifest(mode, fingerprint, plan.entries));
  getLogger().info(exportSummary(plan.create.length, plan.update.length, removed, plan.unchanged.length));
  return planResult(mode, snapshot, { ...plan, remove: plan.remove.slice(0, removed) }, fingerprint, false, options.outputDir);
}

async function readSnapshot(
  database: Database,
  options: Parameters<typeof collectSnapshot>[2],
): Promise<ExportSnapshot> {
  const client = await database.getPool().connect();
  try {
    const begin = database.dialect === 'sqlite'
      ? 'BEGIN'
      : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
    await client.query(begin);
    const snapshot = await collectSnapshot(client, database.dialect, options);
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function validateOptions(mode: string, threshold: number, outputDir: string): void {
  if (mode !== 'curated' && mode !== 'full') throw new Error(`Invalid wiki export mode: ${mode}`);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error(`Invalid wiki importance threshold: ${threshold}`);
  }
  if (!outputDir.trim()) throw new Error('Wiki output directory is required');
}

function planResult(
  mode: 'curated' | 'full',
  snapshot: ExportSnapshot,
  plan: ReturnType<typeof buildExportPlan>,
  fingerprint: string,
  dryRun: boolean,
  outputDir: string,
): WikiExportResult {
  return {
    mode, totalEligible: snapshot.memories.length, notesCreated: plan.create.length,
    notesUpdated: plan.update.length, notesRemoved: plan.remove.length,
    notesUnchanged: plan.unchanged.length, databaseManifest: fingerprint, dryRun, outputDir,
  };
}

function buildManifest(
  mode: 'curated' | 'full',
  databaseManifest: string,
  notes: WikiExportManifest['notes'],
): WikiExportManifest {
  return { schemaVersion: 1, exportedAt: new Date().toISOString(), mode, databaseManifest, notes };
}

function buildLogEntry(
  mode: string,
  plan: ReturnType<typeof buildExportPlan>,
  removed: number,
  totalEligible: number,
) {
  return {
    timestamp: new Date().toISOString(), mode, notesCreated: plan.create.length,
    notesUpdated: plan.update.length, notesRemoved: removed,
    notesUnchanged: plan.unchanged.length, totalEligible,
  };
}

function exportSummary(created: number, updated: number, removed: number, unchanged: number): string {
  return `Wiki export: ${created} created, ${updated} updated, ${removed} removed, ${unchanged} unchanged`;
}

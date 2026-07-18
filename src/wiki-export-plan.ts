import { contentHash } from './work-ledger-lineage.js';
import type { RenderedNote } from './wiki-note-renderer.js';
import type { WikiExportManifest, WikiManifestEntry } from './wiki-export-types.js';

export interface WikiExportPlan {
  entries: Record<string, WikiManifestEntry>;
  create: string[];
  update: string[];
  remove: string[];
  unchanged: string[];
}

export function buildExportPlan(
  notes: RenderedNote[],
  existing: WikiExportManifest | null,
  prune: boolean,
): WikiExportPlan {
  const plan: WikiExportPlan = { entries: {}, create: [], update: [], remove: [], unchanged: [] };
  for (const note of notes) classifyNote(plan, note, existing);
  if (existing && prune) appendRemovals(plan, existing);
  return plan;
}

function classifyNote(
  plan: WikiExportPlan,
  note: RenderedNote,
  existing: WikiExportManifest | null,
): void {
  const hash = contentHash(note.content);
  plan.entries[note.path] = { path: note.path, contentHash: hash };
  const previous = existing?.notes[note.path];
  if (!previous) plan.create.push(note.path);
  else if (previous.contentHash !== hash) plan.update.push(note.path);
  else plan.unchanged.push(note.path);
}

function appendRemovals(plan: WikiExportPlan, existing: WikiExportManifest): void {
  for (const entry of Object.values(existing.notes)) {
    if (!plan.entries[entry.path]) plan.remove.push(entry.path);
  }
}

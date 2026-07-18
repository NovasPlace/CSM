/**
 * Types for CSM → Obsidian wiki export.
 */

import type { MemoryType } from './types.js';

export type WikiExportMode = 'curated' | 'full';

export interface WikiExportOptions {
  /** Output directory (default: "./wiki") */
  outputDir: string;
  /** Filter by project ID */
  projectId?: string;
  /** Filter by memory types (default: all types eligible for the mode) */
  memoryTypes?: MemoryType[];
  /** Export mode (default: "curated") */
  mode?: WikiExportMode;
  /** Importance threshold for curated mode (default: 0.5) */
  importanceThreshold?: number;
  /** Include one-hop linked memories even if below threshold (default: true) */
  includeLinked?: boolean;
  /** Incremental export using manifest (default: true) */
  incremental?: boolean;
  /** Prune notes no longer eligible (only manifest-owned files) (default: false) */
  prune?: boolean;
  /** Dry run: report without writing (default: false) */
  dryRun?: boolean;
}

export interface WikiExportManifest {
  schemaVersion: 1;
  exportedAt: string;
  mode: WikiExportMode;
  /** Cheap fingerprint of DB state: sha256(memory_count + memory_max_updated + link_count + link_max_id + distilled_count + distilled_max_updated) */
  databaseManifest: string;
  notes: Record<string, WikiManifestEntry>;
}

export interface WikiManifestEntry {
  path: string;
  contentHash: string;
  memoryUpdatedAt?: string;
}

export interface WikiExportResult {
  mode: WikiExportMode;
  totalEligible: number;
  notesCreated: number;
  notesUpdated: number;
  notesRemoved: number;
  notesUnchanged: number;
  databaseManifest: string;
  dryRun: boolean;
  outputDir: string;
}

/** Summary of a dry-run report for logging. */
export interface DryRunReport {
  toCreate: string[];
  toUpdate: string[];
  toRemove: string[];
  unchanged: string[];
  totalEligible: number;
}

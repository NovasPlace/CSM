import type { DatabaseClient, Memory, MemoryType } from './types.js';
import type { ExportedEntity, ExportedLink } from './wiki-note-renderer.js';
import type { WikiExportMode } from './wiki-export-types.js';

export type WikiQueryClient = Pick<DatabaseClient, 'query'>;

export interface ExportSnapshot {
  memories: Memory[];
  links: Map<number, ExportedLink[]>;
  entities: ExportedEntity[];
  distilledSummaries: Array<{ sessionId: string; groups: unknown[]; builtAt: string }>;
  stats: WikiDatabaseStats;
}

export interface WikiDatabaseStats {
  memoryCount: number;
  memoryMaxUpdatedAt: string;
  linkCount: number;
  linkMaxId: number;
  distilledCount: number;
  distilledMaxUpdatedAt: string;
}

export interface SnapshotOptions {
  mode: WikiExportMode;
  importanceThreshold: number;
  includeLinked: boolean;
  projectId?: string;
  memoryTypesFilter?: MemoryType[];
}

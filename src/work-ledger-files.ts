import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { contentHash } from './work-ledger-lineage.js';

export interface WorkLedgerFileState {
  exists: boolean;
  hash?: string;
  content: string;
}

export interface ResolvedWorkLedgerPath {
  absolutePath: string;
  relativePath: string;
}

export function extractWorkLedgerPaths(args: Record<string, unknown>): string[] {
  const
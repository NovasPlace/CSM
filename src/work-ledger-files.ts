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
  const paths = new Set<string>();
  addPath(paths, args.filePath);
  addPath(paths, args.path);
  addPathsFromArray(paths, args.files);
  addPathsFromArray(paths, args.edits);
  addPathsFromPatch(paths, args.patch);
  addPathsFromPatch(paths, args.patchText);
  return [...paths];
}

export function resolveWorkLedgerPath(
  projectRoot: string,
  filePath: string,
): ResolvedWorkLedgerPath {
  const root = resolve(projectRoot);
  const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const relativePath = relative(root, absolutePath);
  if (isAbsolute(relativePath) || relativePath === '..'
    || relativePath.startsWith(`..\\`) || relativePath.startsWith('../')) {
    throw new Error(`Work Ledger path escapes project root: ${filePath}`);
  }
  return {
    absolutePath,
    relativePath: relativePath.replace(/\\/g, '/'),
  };
}

export async function readWorkLedgerFile(
  absolutePath: string,
  maxFileBytes: number,
): Promise<WorkLedgerFileState> {
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch (error) {
    if (isMissingFile(error)) return { exists: false, content: '' };
    throw error;
  }
  if (!fileStat.isFile()) throw new Error(`Work Ledger target is not a file: ${absolutePath}`);
  if (fileStat.size > maxFileBytes) {
    throw new Error(`Work Ledger file exceeds ${maxFileBytes} bytes: ${absolutePath}`);
  }
  const bytes = await readFile(absolutePath);
  return {
    exists: true,
    hash: contentHash(bytes),
    content: bytes.includes(0) ? '' : bytes.toString('utf8'),
  };
}

export async function assertWorkLedgerPathSafe(
  projectRoot: string,
  absolutePath: string,
): Promise<void> {
  await canonicalizeWorkLedgerPath(projectRoot, absolutePath);
}

export async function resolveCanonicalWorkLedgerPaths(
  projectRoot: string,
  filePaths: string[],
): Promise<ResolvedWorkLedgerPath[]> {
  const targets = new Map<string, ResolvedWorkLedgerPath>();
  for (const filePath of filePaths) {
    const resolvedPath = resolveWorkLedgerPath(projectRoot, filePath);
    const canonical = await canonicalizeWorkLedgerPath(projectRoot, resolvedPath.absolutePath);
    targets.set(canonical.relativePath, canonical);
  }
  return [...targets.values()];
}

async function canonicalizeWorkLedgerPath(
  projectRoot: string,
  absolutePath: string,
): Promise<ResolvedWorkLedgerPath> {
  const realRoot = await realpath(projectRoot);
  const existingPath = await nearestExistingPath(absolutePath);
  const realExisting = await realpath(existingPath);
  const canonicalPath = resolve(realExisting, relative(existingPath, absolutePath));
  const relativePath = relative(realRoot, canonicalPath);
  if (isAbsolute(relativePath) || relativePath === '..'
    || relativePath.startsWith(`..\\`) || relativePath.startsWith('../')) {
    throw new Error(`Work Ledger path resolves outside project root: ${absolutePath}`);
  }
  return { absolutePath: canonicalPath, relativePath: relativePath.replace(/\\/g, '/') };
}

function addPath(paths: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.trim()) paths.add(value.trim());
}

function addPathsFromArray(paths: Set<string>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    addPath(paths, item);
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    addPath(paths, record.filePath);
    addPath(paths, record.path);
  }
}

function addPathsFromPatch(paths: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const openAiPattern = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm;
  const movePattern = /^\*\*\* Move to:\s*(.+)$/gm;
  const unifiedPattern = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+)$/gm;
  for (const pattern of [openAiPattern, movePattern, unifiedPattern]) {
    for (const match of value.matchAll(pattern)) {
      if (match[1] !== '/dev/null') addPath(paths, match[1]);
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}

async function nearestExistingPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

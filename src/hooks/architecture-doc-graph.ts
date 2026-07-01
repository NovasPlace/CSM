import { promises as fs } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage', '.tmp']);
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

export interface GraphNode {
  file: string;
  exports: string[];
  imports: string[];
}

export async function buildGraph(projectDir: string): Promise<{ nodes: GraphNode[]; dependents: Map<string, Set<string>>; edgeCount: number }> {
  const files = await walkCodeFiles(projectDir);
  const nodes: GraphNode[] = [];
  const importsByFile = new Map<string, string[]>();
  for (const file of files) {
    const content = await readIfExists(file);
    const imports: string[] = [];
    for (const spec of extractImports(content)) {
      const resolved = await resolveImport(projectDir, file, spec);
      if (resolved) imports.push(resolved);
    }
    nodes.push({ file: relative(projectDir, file).replace(/\\/g, '/'), exports: extractExports(content), imports });
    importsByFile.set(file, imports);
  }

  const dependents = new Map<string, Set<string>>();
  for (const [file, imports] of importsByFile.entries()) {
    for (const target of imports) {
      const bucket = dependents.get(target) ?? new Set<string>();
      bucket.add(relative(projectDir, file).replace(/\\/g, '/'));
      dependents.set(target, bucket);
    }
  }

  const edgeCount = Array.from(importsByFile.values()).reduce((sum, imports) => sum + imports.length, 0);
  return { nodes, dependents, edgeCount };
}

async function walkCodeFiles(projectDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      if (IGNORE_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (CODE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        results.push(full);
      }
    }
  }
  await walk(projectDir);
  return results;
}

function extractImports(content: string): string[] {
  const imports: string[] = [];
  const regex = /(?:import|export)\s+.*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const spec = match[1] ?? match[2];
    if (spec) imports.push(spec);
  }
  return [...new Set(imports)];
}

function extractExports(content: string): string[] {
  const exports: string[] = [];
  const regex = /export\s+(?:class|function|const|interface|type|async\s+function|enum)\s+(\w+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) exports.push(match[1]);
  return [...new Set(exports)];
}

async function resolveImport(projectDir: string, fromFile: string, spec: string): Promise<string | undefined> {
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), spec);
  const stem = base.replace(/\.[^.\\/]+$/, '');
  const candidates = [base, stem, ...CODE_EXTENSIONS.map((ext) => stem + ext), ...CODE_EXTENSIONS.map((ext) => join(stem, `index${ext}`))];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      return relative(projectDir, candidate).replace(/\\/g, '/');
    } catch { /* file not found, skip */ }
  }
  return undefined;
}

async function readIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

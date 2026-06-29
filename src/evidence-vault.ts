import { promises as fs } from 'fs';
import { join, relative } from 'path';
import { estimateTokens } from './token-bucket-analyzer.js';

export interface EvidenceRecordInput {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface EvidenceRecord extends EvidenceRecordInput {
  id: string;
  evidenceRef: string;
  rawTokens: number;
}

export interface EvidenceVaultOptions {
  rootDir?: string;
  now?: () => Date;
  maxAgeDays?: number;
  maxFiles?: number;
}

const DEFAULT_ROOT = join(process.cwd(), 'artifacts', 'evidence');
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_FILES = 500;

export class EvidenceVault {
  private rootDir: string;
  private now: () => Date;
  private readonly maxAgeDays: number;
  private readonly maxFiles: number;

  constructor(options: EvidenceVaultOptions = {}) {
    this.rootDir = options.rootDir ?? DEFAULT_ROOT;
    this.now = options.now ?? (() => new Date());
    this.maxAgeDays = options.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  }

  async store(input: EvidenceRecordInput): Promise<EvidenceRecord> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const id = this.buildId(input.command);
    const evidenceRef = join(this.rootDir, `${id}.json`);
    const record: EvidenceRecord = {
      ...input,
      id,
      evidenceRef,
      rawTokens: estimateTokens(`${input.stdout}\n${input.stderr ?? ''}`),
      startedAt: input.startedAt ?? this.now().toISOString(),
      endedAt: input.endedAt ?? this.now().toISOString(),
    };
    await fs.writeFile(evidenceRef, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    return record;
  }

  async read(evidenceRef: string): Promise<EvidenceRecord> {
    const raw = await fs.readFile(evidenceRef, 'utf-8');
    return JSON.parse(raw) as EvidenceRecord;
  }

  toDisplayRef(evidenceRef: string, baseDir = process.cwd()): string {
    return relative(baseDir, evidenceRef).replace(/\\/g, '/');
  }

  async pruneOldEvidence(): Promise<{ deleted: number; remaining: number }> {
    try {
      const files = await fs.readdir(this.rootDir);
      const now = this.now().getTime();
      const maxAgeMs = this.maxAgeDays * 24 * 60 * 60 * 1000;
      let deleted = 0;

      const entries: { name: string; mtime: number }[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = join(this.rootDir, file);
        try {
          const stat = await fs.stat(filePath);
          entries.push({ name: file, mtime: stat.mtimeMs });
        } catch {
          // skip unreadable
        }
      }

      for (const entry of entries) {
        if (now - entry.mtime > maxAgeMs) {
          try {
            await fs.unlink(join(this.rootDir, entry.name));
            deleted++;
          } catch {
            // best-effort
          }
        }
      }

      const remaining = entries.length - deleted;
      if (remaining > this.maxFiles) {
        const survivors = entries
          .filter((e) => now - e.mtime <= maxAgeMs)
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, this.maxFiles);
        for (const entry of entries) {
          if (now - entry.mtime <= maxAgeMs && !survivors.includes(entry)) {
            try {
              await fs.unlink(join(this.rootDir, entry.name));
              deleted++;
            } catch {
              // best-effort
            }
          }
        }
      }

      return { deleted, remaining: Math.max(0, entries.length - deleted) };
    } catch {
      return { deleted: 0, remaining: 0 };
    }
  }

  private buildId(command: string): string {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const slug = command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${stamp}-${slug || 'command'}-${suffix}`;
  }
}

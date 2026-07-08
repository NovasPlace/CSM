import { createHash } from 'crypto';

const DEFAULT_TTL_MS = 60_000;

export class ToolExecuteRuntimeDedup {
  private entries = new Map<string, number>();
  private ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private makeKey(tool: string, args: unknown): string {
    const argsHash = createHash('sha256')
      .update(JSON.stringify(args ?? {}))
      .digest('hex')
      .slice(0, 8);
    return `${tool}:${argsHash}`;
  }

  private prune(now: number): void {
    for (const [key, ts] of this.entries) {
      if (now - ts > this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  shouldSuppress(tool: string, args: unknown): boolean {
    const now = Date.now();
    this.prune(now);
    const key = this.makeKey(tool, args);
    const existing = this.entries.get(key);
    if (existing !== undefined && now - existing <= this.ttlMs) {
      return true;
    }
    this.entries.set(key, now);
    return false;
  }

  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

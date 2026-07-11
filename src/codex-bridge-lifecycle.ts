import type { Database } from './database.js';
import type { WorkLedger } from './work-ledger.js';

export class CodexBridgeLifecycle {
  private readonly completed = new Set<string>();
  private promise: Promise<void> | null = null;
  private state: 'active' | 'closing' | 'closed' = 'active';
  private inFlight = 0;
  private drainResolve: (() => void) | null = null;

  constructor(
    private readonly database: Database,
    private readonly workLedger?: WorkLedger,
  ) {}

  get active(): boolean {
    return this.state === 'active';
  }

  async run<T>(task: () => T | Promise<T>): Promise<T> {
    if (!this.active) throw new Error(`Codex bridge is ${this.state}; operations are unavailable`);
    this.inFlight += 1;
    try {
      return await task();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) this.drainResolve?.();
    }
  }

  disconnect(): Promise<void> {
    if (this.state === 'closed') return Promise.resolve();
    if (this.promise) return this.promise;
    this.state = 'closing';
    const operation = this.shutdown().then(
      () => { this.promise = null; this.state = 'closed'; },
      (error) => { this.promise = null; throw error; },
    );
    this.promise = operation;
    return operation;
  }

  private async shutdown(): Promise<void> {
    await this.waitForDrain();
    await this.runStep('Work Ledger', async () => this.workLedger?.dispose());
    await this.runStep('database', () => this.database.close());
  }

  private waitForDrain(): Promise<void> {
    if (this.inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this.drainResolve = resolve; }).finally(() => {
      this.drainResolve = null;
    });
  }

  private async runStep(label: string, task: () => Promise<unknown>): Promise<void> {
    if (this.completed.has(label)) return;
    try {
      await task();
      this.completed.add(label);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} disconnect failed: ${message}`, { cause: error });
    }
  }
}

import { assertWorkLedgerAvailable } from './codex-bridge-capabilities.js';
import type { PluginConfig } from './types.js';
import type { WorkLedger } from './work-ledger.js';
import type { WorkLedgerCaptureInput, WorkLedgerChange } from './work-ledger-types.js';
import type { CodexBridgeLifecycle } from './codex-bridge-lifecycle.js';

type EnsureSession = (projectRoot?: string, sessionId?: string) => Promise<string | undefined>;

export class CodexBridgeLedgerApi {
  constructor(
    private readonly config: PluginConfig,
    private readonly workLedger: WorkLedger | undefined,
    private readonly ensureSession: EnsureSession,
    private readonly lifecycle: CodexBridgeLifecycle,
  ) {}

  async begin(input: WorkLedgerCaptureInput): Promise<void> {
    await this.lifecycle.run(async () => {
      const ledger = this.require('work_ledger_begin');
      const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
      await ledger.captureBefore({ ...input, sessionId });
    });
  }

  async complete(input: WorkLedgerCaptureInput): Promise<WorkLedgerChange[]> {
    return this.lifecycle.run(async () => {
      const ledger = this.require('work_ledger_complete');
      const sessionId = await this.ensureSession(input.projectRoot, input.sessionId);
      return ledger.captureAfter({ ...input, sessionId });
    });
  }

  surviving(runId: string, projectRoot?: string): Promise<WorkLedgerChange[]> {
    return this.lifecycle.run(() => this.require('work_ledger_surviving')
      .listSurvivingChanges(runId, projectRoot));
  }

  correlate(changeIds: string[], commitSha: string): Promise<number> {
    return this.lifecycle.run(() => this.require('work_ledger_commit')
      .correlateCommit(changeIds, commitSha));
  }

  private require(operation: string): WorkLedger {
    assertWorkLedgerAvailable(
      this.config.databaseProvider, this.config.workLedger.enabled, operation,
    );
    if (!this.workLedger) throw new Error(`${operation} Work Ledger runtime is unavailable.`);
    return this.workLedger;
  }
}

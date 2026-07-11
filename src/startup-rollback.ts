export type StartupCleanup = () => void | Promise<void>;

interface CleanupEntry {
  label: string;
  cleanup: StartupCleanup;
}

export class StartupRollback {
  private readonly entries: CleanupEntry[] = [];
  private committed = false;

  defer(label: string, cleanup: StartupCleanup): void {
    if (this.committed) throw new Error('Startup rollback is already committed');
    this.entries.push({ label, cleanup });
  }

  commit(): void {
    this.committed = true;
    this.entries.length = 0;
  }

  async fail(cause: unknown): Promise<never> {
    const errors: Error[] = [];
    while (this.entries.length > 0) {
      const entry = this.entries.pop();
      if (!entry) continue;
      try {
        await entry.cleanup();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(new Error(`${entry.label}: ${message}`, { cause: error }));
      }
    }
    if (errors.length === 0) throw cause;
    throw new AggregateError([cause, ...errors], 'Plugin startup failed and rollback was incomplete', {
      cause,
    });
  }
}

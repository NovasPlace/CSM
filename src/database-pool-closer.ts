import type { DatabasePool } from './types.js';

export class RetryablePoolCloser {
  private readonly pools = new Set<DatabasePool>();

  get pending(): number {
    return this.pools.size;
  }

  add(pool: DatabasePool): void {
    this.pools.add(pool);
  }

  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const pool of this.pools) {
      try {
        await pool.end();
        this.pools.delete(pool);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Database pools failed to close');
  }
}

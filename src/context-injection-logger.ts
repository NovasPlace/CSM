import type { DatabaseClient, DatabasePool } from './types.js';
import { getLogger } from './logger.js';
import type { BuiltContextInjection, ContextInjectionItem } from './context-injection-contract.js';

export interface ContextInjectionLoggerConfig {
  enabled: boolean;
  environment: 'production' | 'fixture' | 'benchmark';
}

export interface InjectionLogRecord {
  idempotencyKey: string;
  projectId: string | null;
  sessionId: string;
  injectionKind: string;
  sourceTurnId: string | null;
  built: BuiltContextInjection;
  blockHash: string | null;
  status: 'injected' | 'skipped' | 'failed';
}

export class ContextInjectionLogger {
  private static readonly sqliteChains = new WeakMap<DatabasePool, Promise<void>>();
  private readonly pool: DatabasePool;
  private readonly config: ContextInjectionLoggerConfig;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(pool: DatabasePool, config: ContextInjectionLoggerConfig) {
    this.pool = pool;
    this.config = config;
  }

  logInjection(record: InjectionLogRecord): Promise<void> {
    if (!this.config.enabled) return Promise.resolve();
    const prior = this.previousWrite();
    const write = prior
      .catch(() => {})
      .then(() => this.writeRecord(record))
      .catch((error) => {
        getLogger().warn('Context injection telemetry write failed (swallowed): ' + (error instanceof Error ? error.message : String(error)), {
          sessionId: record.sessionId,
        });
      });
    this.writeChain = write;
    if (this.pool.getDialect?.() === 'sqlite') ContextInjectionLogger.sqliteChains.set(this.pool, write);
    return write;
  }

  private previousWrite(): Promise<void> {
    if (this.pool.getDialect?.() !== 'sqlite') return this.writeChain;
    return ContextInjectionLogger.sqliteChains.get(this.pool) ?? Promise.resolve();
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async writeRecord(record: InjectionLogRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const eventId = await this.insertEvent(client, record);
      await this.insertItems(client, eventId, record.built.items);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertEvent(pool: DatabaseClient, record: InjectionLogRecord): Promise<number> {
    const b = record.built;
    const metadata = JSON.stringify(b.metadata);
    const sql = `INSERT INTO context_injection_events
      (idempotency_key, project_id, session_id, injection_kind, source_turn_id,
       environment, status, char_count, estimated_tokens, trim_level,
       block_hash, builder_version, config_hash, error_code, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NULL, $14)
    ON CONFLICT(idempotency_key) DO UPDATE SET idempotency_key = excluded.idempotency_key
    RETURNING id`;

    const params = [
      record.idempotencyKey, record.projectId, record.sessionId,
      record.injectionKind, record.sourceTurnId, this.config.environment,
      record.status ?? 'injected', b.charCount, b.estimatedTokens, b.trimLevel,
      record.blockHash, b.builderVersion, b.configHash, metadata,
    ];

    const result = await pool.query(sql, params);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error('insertEvent returned no rows');
    return Number(row.id);
  }

  private async insertItems(pool: DatabaseClient, eventId: number, items: ContextInjectionItem[]): Promise<void> {
    if (items.length === 0) return;
    let paramIdx = 1;
    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const item of items) {
      const p = (offset: number) => `$${paramIdx + offset}`;
      tuples.push(`(${p(0)}, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)})`);
      values.push(
        eventId, item.layerName, item.sourceKind, item.sourceId, item.memoryId,
        item.position, item.selectionRank, item.selectionScore, item.selectionReason,
        item.disposition, item.provenanceGranularity, item.charCount,
        JSON.stringify(item.metadata),
      );
      paramIdx += 13;
    }

    const sql = `INSERT INTO context_injection_items
      (injection_event_id, layer_name, source_kind, source_id, memory_id,
       position, selection_rank, selection_score, selection_reason_code,
       disposition, provenance_granularity, char_count, metadata)
    VALUES ${tuples.join(', ')}
    ON CONFLICT(injection_event_id, layer_name, position) DO NOTHING`;

    await pool.query(sql, values);
  }
}

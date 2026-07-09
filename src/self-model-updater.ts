import type { DatabasePool, CapabilityName, SelfModelCapability, SelfModelConfig, EvidenceRef } from './types.js';
import { ALL_CAPABILITIES } from './types.js';
import { getLogger } from './logger.js';
import { nowFn, parseArrayField } from './db/query-dialect.js';

type QueryDialect = 'pg' | 'sqlite';

interface PacketRow {
  id: number;
  entry_type: string;
  signals: string | Record<string, unknown>;
  internal_state: string | Record<string, unknown>;
  confidence: number;
  created_at: string | Date;
}

interface CapRow {
  id: number;
  capability: string;
  confidence: number;
  uncertainty: number;
  evidence_refs: string | EvidenceRef[];
  success_count: number;
  failure_count: number;
  drift_warning: boolean | number;
  last_verified: string | Date | null;
  updated_at: string | Date;
}

export class SelfModelUpdater {
  private pool: DatabasePool;
  private dialect: QueryDialect;
  private config: SelfModelConfig;

  constructor(pool: DatabasePool, config: SelfModelConfig) {
    this.pool = pool;
    this.dialect = pool.getDialect?.() ?? 'pg';
    this.config = config;
  }

  async updateAll(): Promise<void> {
    if (!this.config.enabled) return;

    const caps = await this.loadOrCreateCapabilities();
    const packets = await this.loadPackets();

    for (const cap of caps) {
      const evidenceIds = new Set((cap.evidenceRefs || []).map(r => r.packetId));
      const relevant = packets.filter(p => {
        const targetCaps = this.classifyPacket(p);
        return targetCaps.includes(cap.capability) && !evidenceIds.has(p.id);
      });

      if (relevant.length === 0) continue;

      for (const packet of relevant) {
        this.applyEvidence(cap, packet);
      }

      await this.upsertCapability(cap);
    }
  }

  async getAllCapabilities(): Promise<SelfModelCapability[]> {
    return this.loadOrCreateCapabilities();
  }

  async getCapability(name: CapabilityName): Promise<SelfModelCapability | null> {
    try {
      const result = await this.pool.query(
        `SELECT id, capability, confidence, uncertainty, evidence_refs, success_count, failure_count, drift_warning, last_verified, updated_at
         FROM self_model_capabilities
         WHERE capability = $1`,
        [name],
      );
      const row = result.rows[0] as CapRow | undefined;
      return row ? this.mapRow(row) : null;
    } catch {
      return null;
    }
  }

  private async loadOrCreateCapabilities(): Promise<SelfModelCapability[]> {
    const result = await this.pool.query(
      `SELECT id, capability, confidence, uncertainty, evidence_refs, success_count, failure_count, drift_warning, last_verified, updated_at
       FROM self_model_capabilities
       ORDER BY capability`,
    );

    const existing = new Set<string>();
    const caps: SelfModelCapability[] = [];

    for (const row of result.rows as CapRow[]) {
      existing.add(row.capability);
      caps.push(this.mapRow(row));
    }

    for (const name of ALL_CAPABILITIES) {
      if (!existing.has(name)) {
        const inserted = await this.createCapability(name);
        caps.push(inserted);
      }
    }

    // One-time cap: existing confidence values > 0.9 from before the diminishing-returns fix
    try {
      await this.pool.query(
        `UPDATE self_model_capabilities
         SET confidence = 0.9, updated_at = ${nowFn(this.dialect)}
         WHERE confidence > 0.9`,
      );
    } catch {
      // non-fatal
    }

    return caps.sort((a, b) => a.capability.localeCompare(b.capability));
  }

  private async createCapability(name: CapabilityName): Promise<SelfModelCapability> {
    const now = nowFn(this.dialect);
    const d = this.dialect === 'sqlite' ? 0 : false;
    try {
      const result = await this.pool.query(
        `INSERT INTO self_model_capabilities (capability, confidence, uncertainty, evidence_refs, success_count, failure_count, drift_warning, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, ${now})
         RETURNING id, capability, confidence, uncertainty, evidence_refs, success_count, failure_count, drift_warning, last_verified, updated_at`,
        [name, 0.3, 0.5, '[]', 0, 0, d],
      );
      return this.mapRow(result.rows[0] as CapRow);
    } catch (error) {
      getLogger().error(`Failed to create capability ${name}`, error instanceof Error ? error : undefined);
      throw error;
    }
  }

  private loadPackets(): Promise<PacketRow[]> {
    return this.pool.query(
      `SELECT id, entry_type, signals, internal_state, confidence, created_at
       FROM experience_packets
       ORDER BY created_at ASC`,
    ).then(r => r.rows as PacketRow[]).catch(() => []);
  }

  private classifyPacket(packet: PacketRow): CapabilityName[] {
    const caps: CapabilityName[] = [];
    const signals = typeof packet.signals === 'string'
      ? JSON.parse(packet.signals)
      : (packet.signals as Record<string, unknown>);
    const toolName = (signals?.toolName as string | undefined) ?? '';

    if (packet.entry_type === 'tool_execution' || packet.entry_type === 'error') {
      caps.push('tool_use');

      if (toolName) {
        if (['edit', 'write', 'patch'].includes(toolName)) {
          caps.push('code_editing');
        }
        if (toolName.includes('test')) {
          caps.push('test_repair');
        }
        if (toolName.includes('schema') || toolName.includes('migrate')) {
          caps.push('schema_migration');
        }
        if (toolName.startsWith('csm_memory_')) {
          caps.push('memory_recall');
        }
      }
    }

    if (packet.entry_type === 'loop_signal') {
      caps.push('loop_recovery');
    }

    if (packet.entry_type === 'distill_group') {
      caps.push('context_budgeting');
    }

    return caps;
  }

  private determineOutcome(packet: PacketRow, signals: Record<string, unknown>): 'success' | 'failure' | 'mixed' {
    if (packet.entry_type === 'error') return 'failure';
    if (packet.entry_type === 'loop_signal') return 'failure';
    if (packet.entry_type === 'tool_execution') {
      if (signals.error) return 'failure';
      const exitCode = signals.exitCode as number | undefined;
      if (exitCode !== undefined && exitCode !== 0) return 'failure';
      return 'success';
    }
    return 'success';
  }

  private applyEvidence(cap: SelfModelCapability, packet: PacketRow): void {
    const signals = typeof packet.signals === 'string'
      ? JSON.parse(packet.signals)
      : (packet.signals as Record<string, unknown>);
    const outcome = this.determineOutcome(packet, signals);

    if (outcome === 'success') {
      // Diminishing returns: after 20 evidence points, additional successes
      // provide less confidence. Prevents confidence from reaching 1.0 purely
      // from raw tool-call counts — verification (tests, user feedback) needed.
      const totalEvidence = cap.successCount + cap.failureCount;
      const dimRate = totalEvidence < 20
        ? this.config.confidenceIncrementRate
        : this.config.confidenceIncrementRate * (20 / totalEvidence);
      cap.confidence += (1 - cap.confidence) * dimRate;
      cap.successCount++;
    } else if (outcome === 'failure') {
      cap.uncertainty += (1 - cap.uncertainty) * this.config.uncertaintyIncrementRate;
      cap.confidence -= cap.confidence * this.config.confidenceIncrementRate * 0.5;
      cap.failureCount++;
    } else {
      cap.confidence += (1 - cap.confidence) * this.config.confidenceIncrementRate * 0.5;
      cap.uncertainty += (1 - cap.uncertainty) * this.config.uncertaintyIncrementRate * 0.5;
      cap.successCount++;
      cap.failureCount++;
    }

    // Cap at 0.9 — raw tool-call success cannot prove 100% capability.
    // Remaining 0.1 requires explicit verification (tests, user feedback).
    cap.confidence = Math.max(0, Math.min(0.9, cap.confidence));
    cap.uncertainty = Math.max(0, Math.min(1, cap.uncertainty));

    if (cap.uncertainty >= this.config.driftWarningThreshold) {
      cap.driftWarning = true;
    }

    cap.evidenceRefs.push({
      packetId: packet.id,
      entryType: packet.entry_type,
      outcome,
      toolName: (signals?.toolName as string | undefined) ?? undefined,
      timestamp: packet.created_at instanceof Date ? packet.created_at.toISOString() : String(packet.created_at),
    });

    cap.lastVerified = new Date().toISOString();
  }

  private async upsertCapability(cap: SelfModelCapability): Promise<void> {
    const now = nowFn(this.dialect);
    const evidenceJson = JSON.stringify(cap.evidenceRefs);
    const driftVal = this.dialect === 'sqlite' ? (cap.driftWarning ? 1 : 0) : cap.driftWarning;

    try {
      await this.pool.query(
        `INSERT INTO self_model_capabilities (capability, confidence, uncertainty, evidence_refs, success_count, failure_count, drift_warning, last_verified, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ${now})
         ON CONFLICT (capability) DO UPDATE SET
           confidence = EXCLUDED.confidence,
           uncertainty = EXCLUDED.uncertainty,
           evidence_refs = EXCLUDED.evidence_refs,
           success_count = EXCLUDED.success_count,
           failure_count = EXCLUDED.failure_count,
           drift_warning = EXCLUDED.drift_warning,
           last_verified = EXCLUDED.last_verified,
           updated_at = ${now}`,
        [cap.capability, cap.confidence, cap.uncertainty, evidenceJson, cap.successCount, cap.failureCount, driftVal, cap.lastVerified],
      );
    } catch (error) {
      getLogger().error(`Failed to upsert capability ${cap.capability}`, error instanceof Error ? error : undefined);
    }
  }

  private mapRow(row: CapRow): SelfModelCapability {
    const refs: EvidenceRef[] = (parseArrayField(this.dialect, row.evidence_refs) ?? []) as EvidenceRef[];

    return {
      id: row.id,
      capability: row.capability as CapabilityName,
      confidence: row.confidence,
      uncertainty: row.uncertainty,
      evidenceRefs: refs,
      successCount: row.success_count,
      failureCount: row.failure_count,
      driftWarning: this.dialect === 'sqlite' ? Boolean(row.drift_warning) : Boolean(row.drift_warning),
      lastVerified: row.last_verified ? (row.last_verified instanceof Date ? row.last_verified.toISOString() : String(row.last_verified)) : null,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}

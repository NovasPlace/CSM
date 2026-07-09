import type { DatabasePool, BeliefKind, BeliefEntry, EvidenceRef } from './types.js';
import type { BeliefKnowledgeConfig } from './types.js';
import { getLogger } from './logger.js';
import { nowFn } from './db/query-dialect.js';
import type { QueryDialect } from './db/query-dialect.js';

interface CandidateRow {
  id: number;
  candidate_type: string;
  dedup_key: string;
  reason: string;
  confidence: number;
  event_count: number;
  reinforcement_count: number;
  contradicted_count: number;
  last_reinforced_at: string | Date | null;
  source_packet_ids: string | number[];
  status: string;
}

interface BeliefRow {
  id: number;
  belief_kind: string;
  subject: string;
  claim: string;
  stance: string;
  confidence: number;
  uncertainty: number;
  evidence_refs: string | EvidenceRef[];
  contradicted_count: number;
  last_reinforced_at: string | Date | null;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
}

function sanitizeFloat(v: number): number {
  // Non-finite (NaN, Infinity, -Infinity) cannot be stored and indicate a math bug.
  if (!Number.isFinite(v)) return 0;
  // Domain constraint: confidence/uncertainty are [0, 1]. Clamp out-of-range
  // values to satisfy the CHECK constraint, but do NOT floor tiny valid values
  // (e.g. 6.56e-46 from exponential decay) — those are correct belief-state math
  // and are storable in DOUBLE PRECISION columns.
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function parseEvidenceRefs(dialect: string, val: unknown): EvidenceRef[] {
  if (typeof val === 'string') {
    try { return JSON.parse(val) as EvidenceRef[]; } catch { return []; }
  }
  if (Array.isArray(val)) return val as EvidenceRef[];
  return [];
}

function beliefKindFromCandidateType(candidateType: string): BeliefKind | null {
  if (candidateType === 'candidate_preference' || candidateType === 'candidate_belief') return 'preference';
  if (candidateType === 'candidate_opinion') return 'opinion';
  if (candidateType === 'candidate_worldview') return 'worldview';
  return null;
}

function deriveSubject(dedupKey: string, _beliefKind: BeliefKind): string {
  if (!dedupKey) return 'unknown';
  const parts = dedupKey.split(':');
  if (parts.length >= 2) {
    // e.g. "tool:read:ok" → the tool/subject is "tool:read"
    return `${parts[0]}:${parts[1]}`;
  }
  return dedupKey;
}

function deriveClaim(dedupKey: string, beliefKind: BeliefKind, reason: string): string {
  // For preference: "tool:read:ok" → claim is "reads successfully"
  // For opinion: "dec:creation" → claim is from reason
  // For worldview: "ms:completion" → claim is "completes tasks"
  if (!dedupKey) return reason.slice(0, 120);

  const parts = dedupKey.split(':');
  const outcomePart = parts[parts.length - 1];

  if (beliefKind === 'preference') {
    if (outcomePart === 'ok') return 'succeeds reliably';
    if (outcomePart === 'fail') return 'fails frequently';
    return outcomePart;
  }

  if (beliefKind === 'opinion') {
    // Use subject + stance from reason
    return reason.length > 120 ? reason.slice(0, 120) : reason;
  }

  if (beliefKind === 'worldview') {
    if (outcomePart === 'completion') return 'tasks complete successfully';
    if (outcomePart === 'creation') return 'creates new work';
    if (outcomePart === 'exploration') return 'explores actively';
    if (outcomePart === 'fix') return 'fixes issues';
    if (outcomePart === 'refinement') return 'refines existing work';
    if (outcomePart === 'verification') return 'verifies outcomes';
    return outcomePart;
  }

  return reason.slice(0, 120);
}

function deriveStance(beliefKind: BeliefKind, dedupKey: string): 'supports' | 'opposes' | 'neutral' {
  if (beliefKind === 'preference') {
    const parts = dedupKey.split(':');
    const outcome = parts[parts.length - 1];
    if (outcome === 'ok') return 'supports';
    if (outcome === 'fail') return 'opposes';
  }
  if (beliefKind === 'worldview') return 'supports'; // worldviews are positive by default
  if (beliefKind === 'opinion') return 'neutral'; // opinions are contextual/neutral
  return 'neutral';
}

export class BeliefKnowledgeConsolidator {
  private readonly pool: DatabasePool;
  private readonly dialect: QueryDialect;
  private readonly config: BeliefKnowledgeConfig;

  constructor(pool: DatabasePool, config: BeliefKnowledgeConfig) {
    this.pool = pool;
    this.dialect = pool.getDialect?.() ?? 'pg';
    this.config = config;
  }

  async consolidate(): Promise<{ created: number; updated: number; skipped: number; beliefs: BeliefEntry[] }> {
    if (!this.config.enabled) return { created: 0, updated: 0, skipped: 0, beliefs: [] };

    const candidates = await this.loadCandidates();
    const existing = await this.loadExistingBeliefs();
    const beliefMap = new Map<string, BeliefEntry>();

    for (const entry of existing) {
      const key = `${entry.beliefKind}:${entry.subject}:${entry.claim}`;
      beliefMap.set(key, entry);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const c of candidates) {
      const kind = beliefKindFromCandidateType(c.candidate_type);
      if (!kind) { skipped++; continue; }

      const subject = deriveSubject(c.dedup_key, kind);
      const claim = deriveClaim(c.dedup_key, kind, c.reason);
      const key = `${kind}:${subject}:${claim}`;
      const stance = deriveStance(kind, c.dedup_key);

      const existingBelief = beliefMap.get(key);

      if (existingBelief) {
        // Update existing: reinforce or contradict based on alignment
        const isReinforcing = c.reinforcement_count > 0 && c.contradicted_count === 0;
        if (isReinforcing) {
          existingBelief.confidence += (1 - existingBelief.confidence) * 0.1;
          existingBelief.uncertainty -= existingBelief.uncertainty * 0.1;
        } else {
          existingBelief.contradictedCount += c.contradicted_count || 1;
          existingBelief.uncertainty += (1 - existingBelief.uncertainty) * 0.15;
          existingBelief.confidence -= existingBelief.confidence * 0.05;
        }

        existingBelief.confidence = sanitizeFloat(existingBelief.confidence);
        existingBelief.uncertainty = sanitizeFloat(existingBelief.uncertainty);

        if (existingBelief.uncertainty >= 0.7 && existingBelief.contradictedCount > 2) {
          existingBelief.status = 'stale';
        }

        // Merge evidence refs (add new source packet ids as evidence)
        const sourcePktIds = typeof c.source_packet_ids === 'string'
          ? JSON.parse(c.source_packet_ids)
          : c.source_packet_ids;
        if (Array.isArray(sourcePktIds)) {
          const existingIds = new Set(existingBelief.evidenceRefs.map(r => r.packetId));
          for (const pktId of sourcePktIds) {
            if (!existingIds.has(pktId)) {
              existingBelief.evidenceRefs.push({
                packetId: pktId,
                entryType: '',
                outcome: stance === 'opposes' ? 'failure' : 'success',
                timestamp: c.last_reinforced_at instanceof Date
                  ? c.last_reinforced_at.toISOString()
                  : String(c.last_reinforced_at ?? ''),
              });
            }
          }
        }

        existingBelief.lastReinforcedAt = new Date().toISOString();
        updated++;
      } else {
        // Create new belief entry
        const entry: BeliefEntry = {
          beliefKind: kind,
          subject,
          claim,
          stance,
          confidence: c.confidence || 0.3,
          uncertainty: 0.5,
          evidenceRefs: [],
          contradictedCount: c.contradicted_count || 0,
          lastReinforcedAt: new Date().toISOString(),
          status: 'candidate',
          createdAt: '',
          updatedAt: '',
        };

        const sourcePktIds = typeof c.source_packet_ids === 'string'
          ? JSON.parse(c.source_packet_ids)
          : c.source_packet_ids;
        if (Array.isArray(sourcePktIds)) {
          for (const pktId of sourcePktIds) {
            entry.evidenceRefs.push({
              packetId: pktId,
              entryType: '',
              outcome: stance === 'opposes' ? 'failure' : 'success',
              timestamp: c.last_reinforced_at instanceof Date
                ? c.last_reinforced_at.toISOString()
                : String(c.last_reinforced_at ?? ''),
            });
          }
        }

        beliefMap.set(key, entry);
        try {
          await this.upsertBelief(entry);
          created++;
        } catch (error) {
          getLogger().error(
            `Belief consolidation upsert failed (new): ${entry.subject} / ${entry.claim} / ${entry.beliefKind}: ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? error : undefined,
          );
        }
      }
    }

    for (const [, entry] of beliefMap) {
      if (!entry.id) continue;
      try {
        await this.upsertBelief(entry);
      } catch (error) {
        getLogger().error(
          `Belief consolidation upsert failed (update): id=${entry.id} ${entry.subject} / ${entry.claim}: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error : undefined,
        );
      }
    }

    const allBeliefs = [...beliefMap.values()];
    getLogger().info(`Belief consolidation: ${created} created, ${updated} updated, ${skipped} skipped`);

    return { created, updated, skipped, beliefs: allBeliefs };
  }

  async getAllBeliefs(): Promise<BeliefEntry[]> {
    try {
      const result = await this.pool.query(
        `SELECT id, belief_kind, subject, claim, stance, confidence, uncertainty,
                evidence_refs, contradicted_count, last_reinforced_at, status,
                created_at, updated_at
         FROM belief_knowledge_store
         ORDER BY belief_kind, subject`,
      );
      return (result.rows as BeliefRow[]).map(r => this.mapRow(r));
    } catch {
      return [];
    }
  }

  async getBeliefsByKind(kind: BeliefKind): Promise<BeliefEntry[]> {
    try {
      const result = await this.pool.query(
        `SELECT id, belief_kind, subject, claim, stance, confidence, uncertainty,
                evidence_refs, contradicted_count, last_reinforced_at, status,
                created_at, updated_at
         FROM belief_knowledge_store
         WHERE belief_kind = $1
         ORDER BY status, confidence DESC`,
        [kind],
      );
      return (result.rows as BeliefRow[]).map(r => this.mapRow(r));
    } catch {
      return [];
    }
  }

  private async upsertBelief(entry: BeliefEntry): Promise<void> {
    const now = nowFn(this.dialect);
    const evidenceJson = JSON.stringify(entry.evidenceRefs);
    const driftVal = entry.lastReinforcedAt ?? null;

    // Non-finite guard: NaN/Infinity cannot be stored and indicate a math bug.
    // Valid finite values (including subnormals like 6.56e-46) pass through unchanged.
    const confidence = sanitizeFloat(entry.confidence);
    const uncertainty = sanitizeFloat(entry.uncertainty);

    await this.pool.query(
      `INSERT INTO belief_knowledge_store (belief_kind, subject, claim, stance, confidence, uncertainty,
       evidence_refs, contradicted_count, last_reinforced_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, ${now}, ${now})
       ON CONFLICT (belief_kind, subject, claim) DO UPDATE SET
         stance = EXCLUDED.stance,
         confidence = EXCLUDED.confidence,
         uncertainty = EXCLUDED.uncertainty,
         evidence_refs = EXCLUDED.evidence_refs,
         contradicted_count = EXCLUDED.contradicted_count,
         last_reinforced_at = EXCLUDED.last_reinforced_at,
         status = EXCLUDED.status,
         updated_at = ${now}`,
      [
        entry.beliefKind,
        entry.subject,
        entry.claim,
        entry.stance,
        confidence,
        uncertainty,
        evidenceJson,
        entry.contradictedCount,
        driftVal,
        entry.status,
      ],
    );
  }

  private async loadCandidates(): Promise<CandidateRow[]> {
    try {
      const result = await this.pool.query(
        `SELECT id, candidate_type, dedup_key, reason, confidence, event_count,
                reinforcement_count, contradicted_count, last_reinforced_at, source_packet_ids, status
         FROM memory_candidate_queue
          WHERE candidate_type IN ('candidate_preference', 'candidate_worldview', 'candidate_opinion', 'candidate_belief')`,
      );
      return result.rows as CandidateRow[];
    } catch {
      return [];
    }
  }

  async migrateStalePreferenceEntries(): Promise<number> {
    try {
      const result = await this.pool.query(
        `SELECT id, belief_kind, subject, claim, evidence_refs
         FROM belief_knowledge_store
         WHERE belief_kind = 'preference'
           AND claim = 'succeeds reliably'
           AND status != 'stale'`,
      );
      const entries = result.rows as BeliefRow[];
      if (entries.length === 0) return 0;

      const now = nowFn(this.dialect);
      let migrated = 0;

      for (const row of entries) {
        const refs = parseEvidenceRefs(this.dialect, row.evidence_refs);
        refs.push({
          packetId: 0,
          entryType: 'taxonomy_migration',
          outcome: 'mixed',
          timestamp: new Date().toISOString(),
        });

        await this.pool.query(
          `UPDATE belief_knowledge_store
           SET status = 'stale',
               evidence_refs = $1,
               updated_at = ${now}
           WHERE id = $2`,
          [JSON.stringify(refs), row.id],
        );
        migrated++;
      }

      getLogger().info(`Phase E migration: ${migrated} stale preference entries archived (audit note attached)`);
      return migrated;
    } catch {
      return 0;
    }
  }

  private async loadExistingBeliefs(): Promise<BeliefEntry[]> {
    try {
      const result = await this.pool.query(
        `SELECT id, belief_kind, subject, claim, stance, confidence, uncertainty,
                evidence_refs, contradicted_count, last_reinforced_at, status,
                created_at, updated_at
         FROM belief_knowledge_store`,
      );
      return (result.rows as BeliefRow[]).map(r => this.mapRow(r));
    } catch {
      return [];
    }
  }

  private mapRow(row: BeliefRow): BeliefEntry {
    const refs = parseEvidenceRefs(this.dialect, row.evidence_refs);

    return {
      id: row.id,
      beliefKind: row.belief_kind as BeliefKind,
      subject: row.subject,
      claim: row.claim,
      stance: row.stance as BeliefEntry['stance'],
      confidence: row.confidence,
      uncertainty: row.uncertainty,
      evidenceRefs: refs,
      contradictedCount: row.contradicted_count,
      lastReinforcedAt: row.last_reinforced_at
        ? (row.last_reinforced_at instanceof Date ? row.last_reinforced_at.toISOString() : String(row.last_reinforced_at))
        : null,
      status: row.status as BeliefEntry['status'],
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }
}
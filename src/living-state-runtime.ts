import type { DatabasePool, SelfModelCapability, LivingStateConfig } from './types.js';
import type { BeliefScanReport } from './belief-promotion-scanner.js';
import { getLogger } from './logger.js';

interface PacketCount {
  total: number;
  recent: number;
}

export interface SelfModelSnapshot {
  capability: string;
  confidence: number;
  uncertainty: number;
  evidenceCount: number;
  driftWarning: boolean;
}

export interface LivingStatePreview {
  packetsSince: number;
  recentPackets: number;
  candidatesDelta: {
    scanned: number;
    inserted: number;
    updated: number;
    total: number;
    byType: Record<string, number>;
  };
  selfModel: SelfModelSnapshot[];
  beliefKnowledgeDelta: {
    created: number;
    updated: number;
    total: number;
  };
  warnings: string[];
  timestamp: string;
  previewOnly: boolean;
}

interface Scanner {
  scan(config: { dryRun?: boolean; maxPerType?: number; lookbackMinutes?: number }): Promise<BeliefScanReport>;
}

interface ExperiencePackets {
  countAll(): Promise<number>;
}

interface SelfModelUpdater {
  updateAll(): Promise<void>;
  getAllCapabilities(): Promise<SelfModelCapability[]>;
}

interface BeliefConsolidator {
  consolidate(): Promise<{ created: number; updated: number; skipped: number; beliefs: unknown[] }>;
  getAllBeliefs(): Promise<unknown[]>;
}

export class LivingStateRuntime {
  private pool: DatabasePool;
  private config: LivingStateConfig;
  private scanner: Scanner;
  private packets: ExperiencePackets;
  private selfModelUpdater: SelfModelUpdater;
  private consolidator: BeliefConsolidator;
  private lastRunAt: number = 0;

  constructor(
    pool: DatabasePool,
    config: LivingStateConfig,
    scanner: Scanner,
    packets: ExperiencePackets,
    selfModelUpdater: SelfModelUpdater,
    consolidator: BeliefConsolidator,
  ) {
    this.pool = pool;
    this.config = config;
    this.scanner = scanner;
    this.packets = packets;
    this.selfModelUpdater = selfModelUpdater;
    this.consolidator = consolidator;
  }

  async runPass(): Promise<LivingStatePreview> {
    if (!this.config.enabled) {
      return this.emptyPreview('disabled');
    }

    const warnings: string[] = [];

    // 1. Scan recent packets → candidate queue
    let scanReport: BeliefScanReport;
    try {
      scanReport = await this.scanner.scan({
        dryRun: false,
        maxPerType: this.config.maxScanPerType,
        lookbackMinutes: this.config.scanLookbackMinutes,
      });
    } catch (err) {
      getLogger().error('Living state scanner failed', err instanceof Error ? err : undefined);
      scanReport = { patternsFound: 0, packetsScanned: 0, inserted: 0, updated: 0, skippedDuplicates: 0, candidates: [], byType: {}, dryRun: false };
      warnings.push('scanner failed');
    }

    // 2. Snapshot capabilities → update → diff
    let beforeCaps: SelfModelCapability[] = [];
    try {
      beforeCaps = await this.selfModelUpdater.getAllCapabilities();
    } catch {
      warnings.push('self-model snapshot failed');
    }

    try {
      await this.selfModelUpdater.updateAll();
    } catch (err) {
      getLogger().error('Living state self-model update failed', err instanceof Error ? err : undefined);
      warnings.push('self-model update failed');
    }

    let afterCaps: SelfModelCapability[] = [];
    try {
      afterCaps = await this.selfModelUpdater.getAllCapabilities();
    } catch {
      warnings.push('self-model read-back failed');
    }

    const selfModel = this.diffCapabilities(beforeCaps, afterCaps);

    // 3. Consolidate belief knowledge
    let consolidateResult: { created: number; updated: number; skipped: number; beliefs: unknown[] };
    try {
      consolidateResult = await this.consolidator.consolidate();
    } catch (err) {
      getLogger().error('Living state consolidation failed', err instanceof Error ? err : undefined);
      consolidateResult = { created: 0, updated: 0, skipped: 0, beliefs: [] };
      warnings.push('belief consolidation failed');
    }

    let totalBeliefs = 0;
    try {
      const allBeliefs = await this.consolidator.getAllBeliefs();
      totalBeliefs = allBeliefs.length;
    } catch {
      warnings.push('belief read-back failed');
    }

    // 4. Count recent packets
    let packetCounts: PacketCount = { total: 0, recent: 0 };
    try {
      const total = await this.packets.countAll();
      packetCounts = { total, recent: scanReport.packetsScanned };
    } catch {
      warnings.push('packet count failed');
    }

    this.lastRunAt = Date.now();

    return {
      packetsSince: packetCounts.recent,
      recentPackets: packetCounts.total,
      candidatesDelta: {
        scanned: scanReport.packetsScanned,
        inserted: scanReport.inserted,
        updated: scanReport.updated,
        total: scanReport.candidates.length,
        byType: scanReport.byType,
      },
      selfModel,
      beliefKnowledgeDelta: {
        created: consolidateResult.created,
        updated: consolidateResult.updated,
        total: totalBeliefs,
      },
      warnings,
      timestamp: new Date().toISOString(),
      previewOnly: this.config.previewOnly,
    };
  }

  async getPreview(): Promise<LivingStatePreview> {
    if (!this.config.enabled) {
      return this.emptyPreview('disabled');
    }

    const warnings: string[] = [];

    let caps: SelfModelCapability[] = [];
    try {
      caps = await this.selfModelUpdater.getAllCapabilities();
    } catch {
      warnings.push('self-model read failed');
    }

    const selfModel = caps.map(c => ({
      capability: c.capability,
      confidence: c.confidence,
      uncertainty: c.uncertainty,
      evidenceCount: c.evidenceRefs.length,
      driftWarning: c.driftWarning,
    }));

    let totalBeliefs = 0;
    try {
      const beliefs = await this.consolidator.getAllBeliefs();
      totalBeliefs = beliefs.length;
    } catch {
      warnings.push('belief read failed');
    }

    let totalPackets = 0;
    try {
      totalPackets = await this.packets.countAll();
    } catch {
      warnings.push('packet count failed');
    }

    return {
      packetsSince: 0,
      recentPackets: totalPackets,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel,
      beliefKnowledgeDelta: { created: 0, updated: 0, total: totalBeliefs },
      warnings,
      timestamp: new Date().toISOString(),
      previewOnly: this.config.previewOnly,
    };
  }

  async getLatestPacketState(): Promise<{
    entryType: string;
    dominantEmotion: string;
    stance: string;
    outcome: string | null;
  } | null> {
    if (!this.config.enabled) return null;
    try {
      const result = await this.pool.query(
        'SELECT entry_type, internal_state, outcome FROM experience_packets ORDER BY created_at DESC LIMIT 1',
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const rawState = typeof row.internal_state === 'string'
        ? JSON.parse(row.internal_state as string)
        : (row.internal_state as Record<string, unknown> ?? {});
      return {
        entryType: String(row.entry_type ?? ''),
        dominantEmotion: String(rawState.dominantEmotion ?? 'neutral'),
        stance: String(rawState.stance ?? 'exploratory'),
        outcome: row.outcome ? String(row.outcome) : null,
      };
    } catch {
      return null;
    }
  }

  private diffCapabilities(
    before: SelfModelCapability[],
    after: SelfModelCapability[],
  ): SelfModelSnapshot[] {
    const beforeMap = new Map(before.map(c => [c.capability, c]));
    const afterMap = new Map(after.map(c => [c.capability, c]));
    const allCaps = new Set([...beforeMap.keys(), ...afterMap.keys()]);

    return [...allCaps].sort().map(cap => {
      const b = beforeMap.get(cap);
      const a = afterMap.get(cap);
      return {
        capability: cap,
        confidence: a?.confidence ?? b?.confidence ?? 0.3,
        uncertainty: a?.uncertainty ?? b?.uncertainty ?? 0.5,
        evidenceCount: a?.evidenceRefs.length ?? b?.evidenceRefs.length ?? 0,
        driftWarning: a?.driftWarning ?? b?.driftWarning ?? false,
      };
    });
  }

  private emptyPreview(reason: string): LivingStatePreview {
    return {
      packetsSince: 0,
      recentPackets: 0,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [reason === 'disabled' ? 'living state is disabled' : reason],
      timestamp: new Date().toISOString(),
      previewOnly: true,
    };
  }
}
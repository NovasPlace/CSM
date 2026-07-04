import type { LivingStateRuntime, LivingStatePreview } from './living-state-runtime.js';
import type { LivingStateConfig } from './types.js';

interface PacketState {
  entryType: string;
  dominantEmotion: string;
  stance: string;
  outcome: string | null;
}

export interface LivingStateDiagnostic {
  enabled: boolean;
  injectAdvisoryBlock: boolean;
  maxChars: number;
  blockProduced: boolean;
  blockLength: number;
  blockText: string | null;
  sections: {
    internalState: boolean;
    recentSignals: boolean;
    capabilityNotes: boolean;
    candidateBeliefs: boolean;
    warnings: boolean;
  };
  omissions: {
    recentSignals: boolean;
    capabilityNotes: boolean;
    candidateBeliefs: boolean;
    warnings: boolean;
    warningsCondensed: boolean;
    hardTruncated: boolean;
  };
  packetInfo: {
    present: boolean;
    entryType: string;
    dominantEmotion: string;
    stance: string;
    outcome: string | null;
    untrusted: boolean;
  };
  preview: LivingStatePreview;
}

export class LivingStateAdvisor {
  private runtime: LivingStateRuntime;
  private config: LivingStateConfig;

  constructor(runtime: LivingStateRuntime, config: LivingStateConfig) {
    this.runtime = runtime;
    this.config = config;
  }

  async assembleBlock(): Promise<string | null> {
    if (!this.config.enabled || !this.config.injectAdvisoryBlock) {
      return null;
    }

    const preview = await this.runtime.getPreview();
    const packet = await this.runtime.getLatestPacketState();
    const budget = this.config.maxAdvisoryBlockChars;

    const lines = this.buildBlockLines(preview, packet);
    const raw = lines.join('\n');

    if (raw.length <= budget) return raw;

    return this.trimToBudget(lines, budget);
  }

  async diagnose(): Promise<LivingStateDiagnostic> {
    const preview = await this.runtime.getPreview();
    const packet = await this.runtime.getLatestPacketState();
    const block = await this.assembleBlock();

    const sectionsAvailable = {
      internalState: true,
      recentSignals: preview.packetsSince > 0 || preview.candidatesDelta.scanned > 0,
      capabilityNotes: preview.selfModel.length > 0,
      candidateBeliefs: preview.beliefKnowledgeDelta.total > 0 || preview.beliefKnowledgeDelta.created > 0,
      warnings: preview.warnings.length > 0,
    };

    const defaultLines = this.buildBlockLines(preview, packet);
    const defaultBlock = defaultLines.join('\n');

    const omissions = {
      recentSignals: sectionsAvailable.recentSignals && block !== null && !block.includes('Recent signals:'),
      capabilityNotes: sectionsAvailable.capabilityNotes && block !== null && !block.includes('Capability notes:'),
      candidateBeliefs: sectionsAvailable.candidateBeliefs && block !== null && !block.includes('Candidate beliefs:'),
      warnings: sectionsAvailable.warnings && block !== null && !block.includes('Warnings:'),
      warningsCondensed: block !== null && block.includes('Warnings:') && this.isWarningsCondensed(block, defaultBlock),
      hardTruncated: block !== null && block.includes('truncated to budget'),
    };

    return {
      enabled: this.config.enabled,
      injectAdvisoryBlock: this.config.injectAdvisoryBlock,
      maxChars: this.config.maxAdvisoryBlockChars,
      blockProduced: block !== null,
      blockLength: block?.length ?? 0,
      blockText: block,
      sections: sectionsAvailable,
      omissions,
      packetInfo: {
        present: packet !== null,
        entryType: packet?.entryType ?? '',
        dominantEmotion: packet?.dominantEmotion ?? '',
        stance: packet?.stance ?? '',
        outcome: packet?.outcome ?? null,
        untrusted: packet?.outcome === 'untrusted',
      },
      preview,
    };
  }

  private buildBlockLines(preview: LivingStatePreview, packet: PacketState | null): string[] {
    const lines: string[] = [];
    lines.push('');
    lines.push('## Advisory Living State');
    lines.push('Status: preview, not durable truth. Evidence-backed observations.');
    lines.push('');
    this.addInternalState(lines, preview, packet);
    this.addRecentSignals(lines, preview);
    this.addCapabilityNotes(lines, preview);
    this.addCandidateBeliefs(lines, preview);
    this.addWarnings(lines, preview);
    lines.push('');
    lines.push('── end advisory block ──');
    return lines;
  }

  private isWarningsCondensed(block: string, defaultBlock: string): boolean {
    const defaultWarnCount = (defaultBlock.match(/^Warnings$/m) ? 1 : 0) +
      (defaultBlock.match(/^- /gm) ?? []).length;
    const blockWarnCount = (block.match(/^Warnings/m) ? 1 : 0) +
      (block.match(/^- /gm) ?? []).length;
    return blockWarnCount < defaultWarnCount;
  }

  private addInternalState(lines: string[], preview: LivingStatePreview, packet: PacketState | null): void {
    const caps = preview.selfModel;
    const avgConf = caps.length > 0
      ? (caps.reduce((s, c) => s + c.confidence, 0) / caps.length)
      : 0.3;
    const avgUncert = caps.length > 0
      ? (caps.reduce((s, c) => s + c.uncertainty, 0) / caps.length)
      : 0.5;
    const driftCount = caps.filter(c => c.driftWarning).length;
    const riskLevel = driftCount > 2 ? 'high' : driftCount > 0 ? 'medium' : 'low';

    lines.push('Current internal state:');
    lines.push(`- confidence: ${avgConf.toFixed(2)}`);
    lines.push(`- uncertainty: ${avgUncert.toFixed(2)}`);
    lines.push(`- risk: ${riskLevel}${driftCount > 0 ? ` (${driftCount} drift warnings)` : ''}`);

    if (packet) {
      const extLabel = packet.outcome === 'untrusted' ? ' [untrusted trace]' : '';
      lines.push(`- affect/stance: ${packet.dominantEmotion}/${packet.stance}${extLabel}`);
      lines.push(`- attention target: ${packet.entryType}${extLabel}`);
    }

    // Top capability by confidence
    const topCap = caps.length > 0
      ? [...caps].sort((a, b) => b.confidence - a.confidence)[0]
      : null;
    if (topCap) {
      lines.push(`- strongest capability: ${topCap.capability} (conf=${topCap.confidence.toFixed(2)}, ${topCap.evidenceCount} refs)`);
    }

    lines.push('');
  }

  private addRecentSignals(lines: string[], preview: LivingStatePreview): void {
    if (preview.packetsSince === 0 && preview.candidatesDelta.scanned === 0) return;

    const parts: string[] = [];
    parts.push(`Recent signals:`);
    if (preview.packetsSince > 0) {
      parts.push(`- ${preview.packetsSince} packets scanned`);
    }
    if (preview.candidatesDelta.inserted > 0) {
      parts.push(`- ${preview.candidatesDelta.inserted} new candidate(s)`);
    }
    if (preview.candidatesDelta.updated > 0) {
      parts.push(`- ${preview.candidatesDelta.updated} candidate(s) updated`);
    }
    parts.push('');
    for (const p of parts) lines.push(p);
  }

  private addCapabilityNotes(lines: string[], preview: LivingStatePreview): void {
    const caps = preview.selfModel;
    if (caps.length === 0) return;

    const top3 = [...caps].sort((a, b) => (b.confidence + b.evidenceCount * 0.05) - (a.confidence + a.evidenceCount * 0.05)).slice(0, 3);

    lines.push('Capability notes:');
    for (const cap of top3) {
      const drift = cap.driftWarning ? ' ⚠ drift' : '';
      lines.push(`- [${cap.capability}] conf=${cap.confidence.toFixed(2)} uncert=${cap.uncertainty.toFixed(2)} (${cap.evidenceCount} refs)${drift}`);
    }
    lines.push('');
  }

  private addCandidateBeliefs(lines: string[], preview: LivingStatePreview): void {
    // Belief knowledge from runtime doesn't include individual candidates
    // We show the count and delta as evidence-backed summary
    const bd = preview.beliefKnowledgeDelta;
    if (bd.total === 0 && bd.created === 0) return;

    lines.push('Candidate beliefs:');
    lines.push(`- ${bd.total} total, ${bd.created} new this pass, ${bd.updated} updated`);
    lines.push('  (status=candidate, advisory only — not promoted)');
    lines.push('');
  }

  private addWarnings(lines: string[], preview: LivingStatePreview): void {
    if (preview.warnings.length === 0) return;

    lines.push('Warnings:');
    for (const w of preview.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push('');
  }

  private trimToBudget(lines: string[], budget: number): string {
    const result = lines.join('\n');
    if (result.length <= budget) return result;

    const strategies = [
      // Strategy 1: remove candidate beliefs section
      () => this.dropSection(lines, 'Candidate beliefs:', '  (belief details omitted for space)'),
      // Strategy 2: remove capability notes section
      () => this.dropSection(lines, 'Capability notes:', undefined),
      // Strategy 3: remove recent signals section
      () => this.dropSection(lines, 'Recent signals:', undefined),
    ];

    for (const strat of strategies) {
      const candidate = strat();
      if (candidate && candidate.length <= budget) return candidate;
    }

    // If still over budget: preserve a one-line warning summary
    const miniWarning = 'Warnings: drift/contradiction/untrusted evidence present. See csm_living_state_preview.';
    const stateEnd = lines.findIndex(l =>
      l.startsWith('Recent signals:') ||
      l.startsWith('Capability notes:') ||
      l.startsWith('Candidate beliefs:') ||
      l.startsWith('Warnings:'),
    );
    if (stateEnd > 0) {
      const keep = lines.slice(0, stateEnd);
      keep.push(miniWarning);
      keep.push('');
      keep.push('── end advisory block ──');
      const candidate = keep.join('\n');
      if (candidate.length <= budget) return candidate;
    }

    // Last resort: hard truncate to budget
    return result.slice(0, Math.max(budget - 50, 50)) + '\n  (truncated to budget)';
  }

  private dropSection(lines: string[], header: string, placeholder: string | undefined): string | null {
    const start = lines.findIndex(l => l.startsWith(header));
    if (start < 0) return null;

    // Find end of this section (next section header, end marker, or end of array)
    const end = lines.findIndex((l, i) => i > start && (
      l.startsWith('Recent signals:') ||
      l.startsWith('Capability notes:') ||
      l.startsWith('Candidate beliefs:') ||
      l.startsWith('Warnings:') ||
      l.startsWith('── end advisory block ──')
    ));
    const sectionEnd = end > start ? end : lines.length;

    const trimmed = [...lines.slice(0, start)];
    if (placeholder) {
      trimmed.push(placeholder);
      trimmed.push('');
    }
    trimmed.push(...lines.slice(sectionEnd));
    return trimmed.join('\n');
  }
}
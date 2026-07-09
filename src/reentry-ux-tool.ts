import type { ReEntryProtocol, ReEntryConfig, LayerDetail } from './re-entry-protocol.js';

export interface ReEntryPreviewReport {
  previewOnly: boolean;
  wouldInject: boolean;
  blockBuilt: boolean;
  blockText: string | null;
  layersIncluded: string[];
  layersTrimmed: string[];
  layersDropped: string[];
  byteLength: number;
  totalChars: number;
  originalChars: number;
  budgetChars: number;
  approxTokens: number;
  trimLevel: 'none' | 'soft' | 'aggressive';
  enabled: boolean;
  sources: Record<string, string[]>;
  layerDetails: LayerDetail[];
  diagnostics: string[];
}

export interface ReentryPreviewInput {
  sessionId?: string;
  projectId?: string;
}

/**
 * Adapter that wraps the real ReEntryProtocol to produce a UX report.
 *
 * Read-only: calls buildBlock() and diagnose() only. No writes.
 * Derives wouldInject from whether buildBlock returned non-null
 * (ReEntryProtocol.buildBlock already returns null when previewOnly=true),
 * so this adapter does not re-implement injection policy.
 */
export class ReEntryPreviewAdapter {
  private reEntryProtocol: ReEntryProtocol;
  private liveConfig: ReEntryConfig;

  constructor(reEntryProtocol: ReEntryProtocol, config: ReEntryConfig) {
    this.reEntryProtocol = reEntryProtocol;
    this.liveConfig = config;
  }

  async buildPreviewReport(input: ReentryPreviewInput = {}): Promise<ReEntryPreviewReport> {
    const sessionId = input.sessionId ?? 'unknown';
    const projectId = input.projectId ?? 'default';

    const [diagnostic, block] = await Promise.all([
      this.reEntryProtocol.diagnose(sessionId, projectId),
      this.reEntryProtocol.buildBlock(sessionId, projectId),
    ]);

    const byteLength = block !== null ? block.length : 0;
    // previewOnly/enabled come from the live config (same source system-transform.ts uses),
    // so the preview tool always agrees with actual injection behaviour.
    const enabled = this.liveConfig.enabled;
    const previewOnly = this.liveConfig.previewOnly;
    const wouldInject = block !== null;

    const diagnostics: string[] = [
      `Enabled: ${enabled}`,
      `Preview-only: ${previewOnly}`,
      `Would inject: ${wouldInject}`,
      `Block built: ${block !== null}`,
      `Total chars: ${diagnostic.totalChars} / original ${diagnostic.originalChars}`,
      `Budget chars: ${diagnostic.budgetChars}`,
      `Approx tokens: ${diagnostic.approxTokens}`,
      `Trim level: ${diagnostic.trimLevel}`,
    ];

    if (diagnostic.layersBuilt.length > 0) {
      diagnostics.push(`Layers included: ${diagnostic.layersBuilt.join(', ')}`);
    }
    if (diagnostic.layersTrimmed.length > 0) {
      diagnostics.push(`Layers trimmed: ${diagnostic.layersTrimmed.join(', ')}`);
    }
    if (diagnostic.layersDropped.length > 0) {
      diagnostics.push(`Layers dropped: ${diagnostic.layersDropped.join(', ')}`);
    }
    for (const detail of diagnostic.layerDetails) {
      if (detail.status !== 'included') {
        diagnostics.push(
          `  ${detail.name}: ${detail.status} (${detail.trimReason ?? 'unknown'}) — ` +
          `${detail.originalChars}→${detail.finalChars} chars`,
        );
      }
    }
    for (const [layer, srcs] of Object.entries(diagnostic.sources)) {
      if (srcs.length === 0) {
        diagnostics.push(`Source ${layer}: (empty — degraded or missing)`);
      }
    }

    return {
      previewOnly,
      wouldInject,
      blockBuilt: block !== null,
      blockText: block,
      layersIncluded: diagnostic.layersBuilt,
      layersTrimmed: diagnostic.layersTrimmed,
      layersDropped: diagnostic.layersDropped,
      byteLength,
      totalChars: diagnostic.totalChars,
      originalChars: diagnostic.originalChars,
      budgetChars: diagnostic.budgetChars,
      approxTokens: diagnostic.approxTokens,
      trimLevel: diagnostic.trimLevel,
      enabled,
      sources: diagnostic.sources,
      layerDetails: diagnostic.layerDetails,
      diagnostics,
    };
  }

  async formatReport(input: ReentryPreviewInput = {}): Promise<string> {
    const r = await this.buildPreviewReport(input);
    const lines: string[] = [
      '## Re-entry Preview',
      `Session: ${input.sessionId ?? 'unknown'}`,
      `Project: ${input.projectId ?? 'default'}`,
      '',
      '### Status',
      `- Enabled: ${r.enabled}`,
      `- Would inject: ${r.wouldInject}`,
      `- Block built: ${r.blockBuilt}`,
      `- Byte length: ${r.byteLength}`,
      `- Total chars: ${r.totalChars} / original ${r.originalChars} / budget ${r.budgetChars}`,
      `- Approx tokens: ${r.approxTokens}`,
      `- Trim level: ${r.trimLevel}`,
      '',
    ];
    if (r.blockText) {
      lines.push('### Block Content', r.blockText, '');
    } else {
      lines.push('### Block Content', '(no block — preview-only mode, disabled, or no content)', '');
    }
    lines.push('### Layers');
    lines.push(`- Included: ${r.layersIncluded.join(', ') || 'none'}`);
    lines.push(`- Trimmed: ${r.layersTrimmed.join(', ') || 'none'}`);
    lines.push(`- Dropped: ${r.layersDropped.join(', ') || 'none'}`);
    if (r.layerDetails.length > 0) {
      lines.push('', '### Layer Details');
      for (const d of r.layerDetails) {
        const reason = d.trimReason ? ` [${d.trimReason}]` : '';
        lines.push(
          `- ${d.name}: ${d.status}${reason} — ` +
          `${d.originalChars}→${d.finalChars} chars (~${d.approxTokens} tokens)`,
        );
      }
    }
    lines.push('');
    lines.push('### Diagnostics');
    for (const line of r.diagnostics) lines.push(line);
    lines.push('');
    return lines.join('\n');
  }

  async formatJson(input: ReentryPreviewInput = {}): Promise<string> {
    const r = await this.buildPreviewReport(input);
    return JSON.stringify(
      {
        sessionId: input.sessionId ?? 'unknown',
        projectId: input.projectId ?? 'default',
        previewOnly: r.previewOnly,
        wouldInject: r.wouldInject,
        blockBuilt: r.blockBuilt,
        blockText: r.blockText,
        layersIncluded: r.layersIncluded,
        layersTrimmed: r.layersTrimmed,
        layersDropped: r.layersDropped,
        byteLength: r.byteLength,
        totalChars: r.totalChars,
        originalChars: r.originalChars,
        budgetChars: r.budgetChars,
        approxTokens: r.approxTokens,
        trimLevel: r.trimLevel,
        enabled: r.enabled,
        sources: r.sources,
        layerDetails: r.layerDetails,
        diagnostics: r.diagnostics,
      },
      null,
      2,
    );
  }
}

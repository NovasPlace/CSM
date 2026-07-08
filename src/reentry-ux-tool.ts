import type { ReEntryProtocol, ReEntryConfig } from './re-entry-protocol.js';

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
  budgetChars: number;
  trimLevel: 'none' | 'soft' | 'aggressive';
  enabled: boolean;
  sources: Record<string, string[]>;
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
      `Total chars: ${diagnostic.totalChars}`,
      `Budget chars: ${diagnostic.budgetChars}`,
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
      budgetChars: diagnostic.budgetChars,
      trimLevel: diagnostic.trimLevel,
      enabled,
      sources: diagnostic.sources,
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
      `- Total chars: ${r.totalChars} / budget ${r.budgetChars}`,
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
        budgetChars: r.budgetChars,
        trimLevel: r.trimLevel,
        enabled: r.enabled,
        sources: r.sources,
        diagnostics: r.diagnostics,
      },
      null,
      2,
    );
  }
}

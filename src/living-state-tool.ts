import { tool } from '@opencode-ai/plugin/tool';
import type { LivingStateRuntime } from './living-state-runtime.js';
import type { LivingStateAdvisor } from './living-state-advisor.js';

export function livingStatePreviewTool(runtime: LivingStateRuntime) {
  return tool({
    description:
      'Preview the living state — recent experience packets, candidate deltas, ' +
      'self-model capability state, and belief knowledge. ' +
      'Read-only: runs the advisory pipeline (scan + update + consolidate) but ' +
      'never injects into context or writes to durable memory. ' +
      'Preview-only by default.',
    args: {
      runPass: tool.schema.boolean().optional().describe(
        'Run a full advisory pipeline pass before returning preview (default true). ' +
        'Set false for a static snapshot without mutation.',
      ),
    },
    async execute(args, _context) {
      const runPass = args.runPass !== false;

      const preview = runPass
        ? await runtime.runPass()
        : await runtime.getPreview();

      const lines: string[] = [
        `=== LIVING STATE PREVIEW ${runPass ? '(fresh pass)' : '(static snapshot)'} ===`,
        `Timestamp: ${preview.timestamp}`,
        `Mode: ${preview.previewOnly ? 'PREVIEW ONLY (no context injection)' : 'LIVE'}`,
        `Warnings: ${preview.warnings.length > 0 ? preview.warnings.join(', ') : 'none'}`,
        '',
      ];

      lines.push(`── Experience Packets ──`);
      lines.push(`  Recent scanned: ${preview.packetsSince}`);
      lines.push(`  Total: ${preview.recentPackets}`);
      lines.push('');

      lines.push(`── Candidate Queue (from scan) ──`);
      if (preview.candidatesDelta.scanned > 0 || preview.candidatesDelta.total > 0) {
        lines.push(`  Scanned packets: ${preview.candidatesDelta.scanned}`);
        lines.push(`  New candidates: ${preview.candidatesDelta.inserted} inserted, ${preview.candidatesDelta.updated} updated`);
        lines.push(`  Total active: ${preview.candidatesDelta.total}`);
        const byType = Object.entries(preview.candidatesDelta.byType).filter(([, n]) => n > 0);
        if (byType.length > 0) {
          lines.push('  By type:');
          for (const [t, n] of byType) {
            lines.push(`    ${t}: ${n}`);
          }
        }
      } else {
        lines.push('  No recent candidate activity.');
      }
      lines.push('');

      lines.push(`── Self-Model Capabilities ──`);
      const driftCaps = preview.selfModel.filter(c => c.driftWarning);
      if (preview.selfModel.length === 0) {
        lines.push('  No capabilities tracked.');
      } else {
        for (const cap of preview.selfModel) {
          const driftMark = cap.driftWarning ? ' ⚠ DRIFT' : '';
          lines.push(
            `  [${cap.capability}] conf=${cap.confidence.toFixed(3)} uncert=${cap.uncertainty.toFixed(3)} evidence=${cap.evidenceCount}${driftMark}`,
          );
        }
        if (driftCaps.length > 0) {
          lines.push('');
          lines.push(`  ⚠ Drift warnings: ${driftCaps.map(c => c.capability).join(', ')}`);
        }
      }
      lines.push('');

      lines.push(`── Belief Knowledge ──`);
      lines.push(`  Created: ${preview.beliefKnowledgeDelta.created}`);
      lines.push(`  Updated: ${preview.beliefKnowledgeDelta.updated}`);
      lines.push(`  Total beliefs: ${preview.beliefKnowledgeDelta.total}`);
      lines.push('');

      if (preview.warnings.length > 0) {
        lines.push(`── Warnings ──`);
        for (const w of preview.warnings) {
          lines.push(`  ⚠ ${w}`);
        }
        lines.push('');
      }

      lines.push('── Guardrails ──');
      lines.push('  No prompt/context injection performed.');
      lines.push('  No durable memory writes.');
      lines.push('  No promotion or training.');
      lines.push('  All claims backed by evidence refs.');

      return {
        title: 'Living State Preview',
        output: lines.join('\n'),
        metadata: {
          preview,
          runPass,
          guardrails: {
            noContextInjection: true,
            noMemoryWrites: true,
            noPromotion: true,
            evidenceRefsRequired: true,
          },
        },
      };
    },
  });
}

export function livingStateDebugTool(advisor: LivingStateAdvisor) {
  return tool({
    description:
      'Diagnose the advisory living-state block assembly. Shows whether the block is produced, ' +
      'which sections are present/omitted, budget decisions, and raw state. ' +
      'Read-only: no mutations performed.',
    args: {},
    async execute(_args, _context) {
      const diag = await advisor.diagnose();

      const lines: string[] = [];
      lines.push(`=== LIVING STATE ADVISORY BLOCK — DIAGNOSTIC ===`);
      lines.push(`Config: enabled=${diag.enabled} injectAdvisoryBlock=${diag.injectAdvisoryBlock} maxChars=${diag.maxChars}`);
      lines.push(`Block produced: ${diag.blockProduced} (length: ${diag.blockLength})`);
      lines.push('');

      if (!diag.blockProduced) {
        const reasons: string[] = [];
        if (!diag.enabled) reasons.push('livingState.enabled = false');
        if (!diag.injectAdvisoryBlock) reasons.push('livingState.injectAdvisoryBlock = false');
        lines.push(`Omitted: ${reasons.length > 0 ? reasons.join(', ') : 'no data to assemble'}`);
        lines.push('');
        lines.push('Run `csm_living_state_preview` to check if the upstream pipeline has data.');
      } else {
        lines.push(`── Sections (available → in block) ──`);
        for (const [key, available] of Object.entries(diag.sections)) {
          if (key === 'internalState') continue; // always present
          const omitted = diag.omissions[key as keyof typeof diag.omissions];
          if (!available) {
            lines.push(`  ${key}: not available (no data)`);
          } else if (omitted) {
            lines.push(`  ${key}: ⚠ OMITTED (budget trimming)`);
          } else {
            lines.push(`  ${key}: ✓ present`);
          }
        }
        lines.push('');

        if (diag.omissions.warningsCondensed) {
          lines.push('  ⚠ Warnings section condensed to one-liner (budget pressure)');
        }
        if (diag.omissions.hardTruncated) {
          lines.push('  ⚠ Block was hard-truncated (budget too tight for full sections)');
        }

lines.push(`── Budget ──`);
          lines.push(`  Final block length: ${diag.blockLength}`);
          lines.push(`  Budget: ${diag.maxChars}`);
          lines.push(`  Waste: ${diag.maxChars - diag.blockLength} chars`);
        lines.push('');

        lines.push(`── Raw block ──`);
        if (diag.blockText) {
          lines.push(diag.blockText);
        }
        lines.push('');

        lines.push(`── Source packet ──`);
        if (diag.packetInfo.present) {
          const untrusted = diag.packetInfo.untrusted ? ' [untrusted]' : '';
          lines.push(`  entryType: ${diag.packetInfo.entryType}${untrusted}`);
          lines.push(`  dominantEmotion: ${diag.packetInfo.dominantEmotion}`);
          lines.push(`  stance: ${diag.packetInfo.stance}`);
          lines.push(`  outcome: ${diag.packetInfo.outcome ?? 'none'}`);
        } else {
          lines.push(`  No recent packet data.`);
        }
        lines.push('');

        lines.push(`── Raw preview counts ──`);
        lines.push(`  packets: ${diag.preview.recentPackets}`);
        lines.push(`  candidates: ${diag.preview.candidatesDelta.total}`);
        lines.push(`  self-model capabilities: ${diag.preview.selfModel.length}`);
        lines.push(`  belief knowledge entries: ${diag.preview.beliefKnowledgeDelta.total}`);
        lines.push(`  warnings: ${diag.preview.warnings.length}`);
      }

      return {
        title: 'Living State Advisory Debug',
        output: lines.join('\n'),
        metadata: diag,
      };
    },
  });
}
import type { CrossSessionLinkInput } from '../cross-session-causal-types.js';
import { CANONICAL_LINKS, CANONICAL_PHASES } from '../self-continuity-narrative-canonical.js';
import { CANONICAL_STITCHES } from '../self-continuity-narrative-canonical.js';
import { estimateDeepTokens } from './system-transform-live-deep-types.js';

export function appendCausalProofChain(
  lines: string[],
  links: CrossSessionLinkInput[],
  tokensUsed: number,
  maxTokens: number,
): void {
  if (links.length === 0 || tokensUsed >= maxTokens) return;
  lines.push('## Cross-Session Causal Links (Proof Chain)', '');
  for (const link of links) {
    if (tokensUsed > maxTokens) break;
    const source = link.sourceSessionId ?? '?';
    const target = link.targetSessionId ?? '?';
    const confidence = link.confidence != null
      ? ` confidence=${(link.confidence * 100).toFixed(0)}%`
      : '';
    lines.push(`- [${link.linkType ?? 'temporal'}] ${source}→${target}${confidence}`);
    if (link.evidenceAnchors?.length) {
      lines.push(`  evidence [direct]: ${link.evidenceAnchors.join('; ')}`);
    }
    if (link.gapKind) lines.push(`  gap [gap]: ${link.gapKind}`);
  }
  lines.push('');
}

export function appendCanonicalStitches(
  lines: string[],
  tokensUsed: number,
  maxTokens: number,
): void {
  if (CANONICAL_STITCHES.length === 0 || tokensUsed >= maxTokens) return;
  lines.push('## Cross-Session Stitch Evidence (Session D → E → Phase 22)', '');
  for (const stitch of CANONICAL_STITCHES) {
    if (tokensUsed > maxTokens) break;
    const source = stitch.sourceSessionId ?? '?';
    const target = stitch.targetSessionId ?? '?';
    lines.push(`- [${stitch.linkType ?? 'inferred'}] ${source}→${target}`);
    if (stitch.evidenceAnchors?.length) {
      lines.push(`  evidence [direct]: ${stitch.evidenceAnchors.join('; ')}`);
    }
    if (stitch.gapKind) lines.push(`  gap [gap]: ${stitch.gapKind}`);
  }
  lines.push('');
}

export function appendPhaseCausation(
  lines: string[],
  initialTokens: number,
  maxTokens: number,
): number {
  if (initialTokens >= maxTokens) return initialTokens;
  lines.push('## Phase Causation Chain', '');
  let tokensUsed = initialTokens;
  for (const link of CANONICAL_LINKS) {
    if (tokensUsed > maxTokens) break;
    const label = link.causationType === 'exposed_gap'
      ? 'inferred'
      : link.causationType === 'direct_fix' ? 'direct' : 'gap';
    lines.push(`- [${label}] Phase ${link.fromPhase} → Phase ${link.toPhase}: ${link.summary}`);
    tokensUsed += estimateDeepTokens(lines[lines.length - 1]);
  }
  for (const phase of CANONICAL_PHASES) {
    if (tokensUsed > maxTokens) break;
    lines.push(`- Phase ${phase.phase}: ${phase.name} — ${phase.problem} → ${phase.action} → ${phase.result}`);
    tokensUsed += estimateDeepTokens(lines[lines.length - 1]);
  }
  lines.push('');
  return tokensUsed;
}


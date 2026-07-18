import { tool } from '@opencode-ai/plugin/tool';
import type { PluginState } from './plugin-context.js';
import type { WorkLedger } from './work-ledger.js';

export function workLedgerSurvivingTool(
  ledger: WorkLedger,
  state: PluginState,
  defaultProjectRoot: string,
) {
  return tool({
    description: 'Show file changes attributed to a run that still survive in the current working tree. ' +
      'Recomputes active and partially-superseded status from SHA-256 line lineage before returning.',
    args: {
      runId: tool.schema.string().optional().describe('Run ID (defaults to the current plugin run)'),
    },
    async execute(args) {
      const runId = args.runId ?? state.runId;
      if (!runId) {
        return {
          title: 'Work Ledger: run unavailable',
          output: 'No current run ID is available.',
          metadata: { count: 0, runId: null },
        };
      }
      const changes = await ledger.listSurvivingChanges(runId, defaultProjectRoot);
      const provenanceGaps = changes.filter((change) => change.modelId === 'unknown').length;
      return {
        title: `Work Ledger: ${changes.length} observed surviving changes`,
        output: formatSurvivingChanges(runId, changes),
        metadata: {
          runId,
          count: changes.length,
          provenanceGaps,
          captureScope: 'supported_file_tools_only',
          runComplete: false,
          changes,
        },
      };
    },
  });
}

function formatSurvivingChanges(
  runId: string,
  changes: Awaited<ReturnType<WorkLedger['listSurvivingChanges']>>,
): string {
  if (changes.length === 0) return `No observed surviving changes found for run ${runId}.`;
  const lines = [`Observed surviving changes for run ${runId}:`];
  for (const change of changes) {
    lines.push(
      `- ${change.filePath} [${change.status}] change=${change.changeId}`,
      `  model=${change.modelId}${change.modelId === 'unknown' ? ' [provenance_gap]' : ''} ` +
        `tool_call=${change.toolCallId ?? 'unknown'}`,
      `  patch=${change.patchHash} surviving=${change.survivingPatchHash ?? 'none'}`,
    );
  }
  return lines.join('\n');
}

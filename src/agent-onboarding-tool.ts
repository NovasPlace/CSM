/**
 * csm_onboard_agent — Unified startup packet tool.
 *
 * Builds and returns a 10-section onboarding packet for the current session.
 * Read-only: queries existing systems, never writes.
 */

import { tool } from '@opencode-ai/plugin/tool';
import { buildOnboardingPacket, formatOnboardingBlock } from './agent-onboarding.js';
import type { PluginContext } from './plugin-context.js';

export function onboardAgentTool(pluginCtx: PluginContext) {
  return tool({
    description: 'Build a structured startup packet for this agent session. Returns identity brief, project continuity, phase/checkpoint, constraints, relevant memories, promoted beliefs, advisories, tool guidance, handoff state, and readiness summary. Read-only: queries existing systems, never writes.',
    args: {
      sections: tool.schema.array(tool.schema.string()).optional().describe('Only return these sections (e.g. ["identity-brief", "advisories"])'),
    },
    async execute(args, context) {
      const workspacePath = pluginCtx.directory || process.cwd();
      const projectId = workspacePath;
      const sessionId = context.sessionID ?? pluginCtx.state.currentSessionId ?? 'current';

      const packet = await buildOnboardingPacket({
        projectId,
        sessionId,
        workspacePath,
        pool: pluginCtx.database.getPool(),
        config: pluginCtx.config,
      });

      const filteredPacket = args.sections?.length
        ? { ...packet, sections: packet.sections.filter(s => args.sections!.includes(s.section)) }
        : packet;

      const block = formatOnboardingBlock(filteredPacket);

      return {
        output: block,
        metadata: {
          sectionCount: filteredPacket.sections.length,
          tokenEstimate: filteredPacket.tokenEstimate,
          builtAt: packet.builtAt.toISOString(),
        },
      };
    },
  });
}

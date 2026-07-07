import { tool } from '@opencode-ai/plugin/tool';
import type { ExperiencePacketCreator, ExperiencePacket } from './experience-packet.js';

export function memoryPacketsTool(creator: ExperiencePacketCreator) {
  return tool({
    description:
      'List recent experience packets with derived internal state. ' +
      'Shows event summary, source refs, outcome, and full internal state ' +
      '(cognitive load, frustration, energy, dominant emotion, stance, urgency) ' +
      'for each recorded tool execution, error, milestone, or session event.',
    args: {
      limit: tool.schema.number().optional().describe('Max packets to return (default 10)'),
      sessionId: tool.schema.string().optional().describe('Filter by session ID'),
    },
    async execute(args) {
      const limit = args.limit ?? 10;
      const packets = args.sessionId
        ? await creator.getSessionPackets(args.sessionId, limit)
        : await creator.getRecentPackets(limit);

      if (packets.length === 0) {
        return {
          title: 'No Experience Packets',
          output: 'No experience packets found.' + (args.sessionId ? ` Session: ${args.sessionId.slice(0, 12)}` : ''),
          metadata: { count: 0 },
        };
      }

      const total = await creator.countAll();
      const lines: string[] = [
        `=== EXPERIENCE PACKETS (${packets.length} shown / ${total} total) ===`,
        '',
      ];

      for (const p of packets) {
        const ts = formatTime(p.createdAt);
        const sess = p.sessionId.slice(0, 8);
        const s = p.internalState;
        const eventLine = formatEventSummary(p);
        const outcomeLine = formatOutcome(p);

        lines.push(
          `#${p.id} [${p.entryType}] ${ts}`,
          `  Event: ${eventLine}`,
          `  Source: session=${sess} | confidence=${(p.confidence * 100).toFixed(0)}%`,
        );

        if (outcomeLine) {
          lines.push(`  Outcome: ${outcomeLine}`);
        }

        lines.push(
          `  State:  load=${(s.cognitiveLoad * 100).toFixed(0)}%  frust=${(s.frustration * 100).toFixed(0)}%  energy=${(s.energy * 100).toFixed(0)}%`,
          `          emotion=${s.dominantEmotion}  stance=${s.stance}  urgency=${(s.urgency * 100).toFixed(0)}%`,
          '',
        );
      }

      return {
        title: 'Experience Packets',
        output: lines.join('\n'),
        metadata: {
          count: packets.length,
          total,
          sessionId: args.sessionId,
          packets: packets.map(p => ({
            id: p.id,
            entryType: p.entryType,
            eventSummary: formatEventSummary(p),
            outcome: formatOutcome(p),
            internalState: p.internalState,
            confidence: p.confidence,
            createdAt: p.createdAt,
          })),
        },
      };
    },
  });
}

function formatTime(ts: Date | undefined): string {
  if (!ts) return '?';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
}

function formatEventSummary(p: ExperiencePacket): string {
  const sig = p.signals;
  const toolName = sig.toolName as string | undefined;
  const intent = sig.intent as string | undefined;
  const msgCount = sig.messageCount as number | undefined;

  switch (p.entryType) {
    case 'tool_execution':
    case 'error':
      if (toolName) {
        const args = sig.argsPreview as string | undefined;
        return args ? `${toolName} ${args}` : toolName;
      }
      return toolName ?? p.entryType;
    case 'milestone':
      return intent ?? 'milestone reached';
    case 'decision':
      return intent ?? 'decision made';
    case 'session_start':
      return 'session started';
    case 'session_checkpoint':
      return msgCount !== undefined ? `session checkpoint (${msgCount} messages)` : 'session checkpoint';
    case 'session_end':
      return msgCount !== undefined ? `session ended (${msgCount} messages)` : 'session ended';
    case 'loop_signal':
      return `${sig.toolName as string ?? '?'} loop (×${sig.callCount as number ?? '?'})`;
    case 'distill_group':
      return 'tool calls distilled';
    default:
      return p.entryType;
  }
}

function formatOutcome(p: ExperiencePacket): string {
  const sig = p.signals;
  const exitCode = sig.exitCode as number | undefined;
  const error = sig.error as string | undefined;

  if (error) return `error: ${error.slice(0, 120)}`;
  if (exitCode !== undefined && exitCode !== 0) return `exit ${exitCode}`;
  if (p.entryType === 'error') return 'error (no detail)';
  if (exitCode === 0) return 'exit 0';
  return '';
}

import { tool } from '@opencode-ai/plugin/tool';
import type { AgentBookEventStore } from './agentbook-event-store.js';
import { generateFrontPage, writeFrontPageFile } from './agentbook-frontpage.js';
import type { AgentBookRulesStore } from './agentbook-rules-store.js';
import type { AgentBookStateProjector } from './agentbook-state-projector.js';
import type { AgentBookSummaryGenerator } from './agentbook-summary-generator.js';
import { AGENTBOOK_EVENT_TYPES } from './agentbook-types.js';
import type { AgentBookEvent, AgentBookEventType, AgentBookRule } from './agentbook-types.js';

const EVENT_TYPES = [...AGENTBOOK_EVENT_TYPES] as [AgentBookEventType, ...AgentBookEventType[]];

export interface AgentBookToolDeps {
  eventStore: AgentBookEventStore;
  rulesStore: AgentBookRulesStore;
  stateProjector: AgentBookStateProjector;
  summaryGenerator: AgentBookSummaryGenerator;
}

function formatEvent(event: AgentBookEvent): string {
  const session = event.sessionId ? ` session=${event.sessionId}` : '';
  const files = event.files.length > 0 ? ` files=${event.files.join(',')}` : '';
  return `${event.timestamp} ${event.eventId} [${event.eventType}]${session}${files}\n  ${event.summary}`;
}

function formatRule(rule: AgentBookRule): string {
  const status = rule.active ? 'active' : 'inactive';
  const trigger = rule.trigger ? ` trigger=${rule.trigger}` : '';
  return `${rule.ruleId} [${status}] P${rule.priority} ${rule.scope}/${rule.overridePolicy}${trigger}\n  ${rule.instruction}`;
}

export function agentBookEventsTool(eventStore: AgentBookEventStore) {
  return tool({
    description: 'Query the AgentBook append-only event ledger by project, session, event type, event ID, or cursor.',
    args: {
      action: tool.schema.enum(['list', 'get', 'since', 'counts']).optional()
        .describe('Operation to perform (default: list)'),
      projectId: tool.schema.string().optional().describe('Project ID filter; required for since and project counts'),
      sessionId: tool.schema.string().optional().describe('Session ID filter'),
      eventType: tool.schema.enum(EVENT_TYPES).optional().describe('Event type filter'),
      eventId: tool.schema.string().optional().describe('Event ID for get'),
      sinceEventId: tool.schema.string().optional().describe('Return project events after this event ID'),
      limit: tool.schema.number().optional().describe('Maximum events to return (default 50)'),
      offset: tool.schema.number().optional().describe('Pagination offset (default 0)'),
    },
    async execute(args) {
      const action = args.action ?? 'list';
      if (action === 'get') {
        if (!args.eventId) throw new Error('eventId is required for AgentBook event get');
        const event = await eventStore.getEvent(args.eventId);
        return {
          title: event ? `AgentBook Event: ${event.eventId}` : 'AgentBook Event Not Found',
          output: event ? formatEvent(event) : `No AgentBook event found for ${args.eventId}.`,
          metadata: { event },
        };
      }
      if (action === 'since') {
        if (!args.projectId || !args.sinceEventId) {
          throw new Error('projectId and sinceEventId are required for AgentBook event since');
        }
        const events = await eventStore.getEventsSince(args.projectId, args.sinceEventId);
        return {
          title: `AgentBook Events Since: ${events.length}`,
          output: events.length > 0 ? events.map(formatEvent).join('\n\n') : 'No later AgentBook events found.',
          metadata: { count: events.length, events },
        };
      }
      if (action === 'counts') {
        const [eventCount, sessionCount] = await Promise.all([
          eventStore.countEvents(args.projectId),
          eventStore.countSessions(args.projectId),
        ]);
        return {
          title: 'AgentBook Counts',
          output: `Events: ${eventCount}\nSessions: ${sessionCount}`,
          metadata: { projectId: args.projectId, eventCount, sessionCount },
        };
      }
      const events = await eventStore.listEvents({
        projectId: args.projectId,
        sessionId: args.sessionId,
        eventType: args.eventType,
        limit: args.limit,
        offset: args.offset,
      });
      return {
        title: `AgentBook Events: ${events.length}`,
        output: events.length > 0 ? events.map(formatEvent).join('\n\n') : 'No AgentBook events matched.',
        metadata: { count: events.length, events },
      };
    },
  });
}

export function agentBookStateTool(deps: AgentBookToolDeps) {
  return tool({
    description: 'Project and display AgentBook current state with its generated front-page markdown.',
    args: {
      projectId: tool.schema.string().describe('Project ID to project'),
      refreshSummary: tool.schema.boolean().optional()
        .describe('Generate a threshold summary before projecting state (default true)'),
      recentLimit: tool.schema.number().optional().describe('Recent events included in the front page (default 10)'),
    },
    async execute(args) {
      if (args.refreshSummary ?? true) await deps.summaryGenerator.maybeGenerate(args.projectId);
      const state = await deps.stateProjector.project(args.projectId);
      const [latestSummary, rules, recentEvents] = await Promise.all([
        deps.summaryGenerator.getLatestSummary(args.projectId),
        deps.rulesStore.getActiveRules(),
        deps.eventStore.getRecentEvents(args.projectId, args.recentLimit ?? 10),
      ]);
      const frontPage = generateFrontPage(state, latestSummary, rules, recentEvents);
      try {
        writeFrontPageFile(frontPage.markdown, process.cwd());
      } catch (_writeError) {
        // File write is best-effort; the markdown is still returned as output
      }
      return {
        title: `AgentBook State: ${args.projectId}`,
        output: frontPage.markdown,
        metadata: { state, latestSummary, rules, recentEvents, frontPage },
      };
    },
  });
}

export function agentBookRuleTool(rulesStore: AgentBookRulesStore) {
  return tool({
    description: 'Add, list, or deactivate explicit AgentBook operating rules.',
    args: {
      action: tool.schema.enum(['add', 'list', 'deactivate']).optional()
        .describe('Operation to perform (default: list)'),
      ruleId: tool.schema.string().optional().describe('Rule ID for deactivate'),
      scope: tool.schema.enum(['project', 'session', 'global']).optional().describe('Rule scope or list filter'),
      priority: tool.schema.number().optional().describe('Rule priority; higher values apply first'),
      trigger: tool.schema.string().optional().describe('Optional activation trigger'),
      instruction: tool.schema.string().optional().describe('Rule instruction for add'),
      overridePolicy: tool.schema.enum(['override', 'augment', 'block']).optional()
        .describe('How the rule affects existing behavior'),
      active: tool.schema.boolean().optional().describe('Active-state filter for list or initial state for add'),
    },
    async execute(args) {
      const action = args.action ?? 'list';
      if (action === 'add') {
        if (!args.instruction) throw new Error('instruction is required to add an AgentBook rule');
        const rule = await rulesStore.addRule({
          scope: args.scope,
          priority: args.priority,
          trigger: args.trigger,
          instruction: args.instruction,
          overridePolicy: args.overridePolicy,
          active: args.active,
        });
        return { title: `AgentBook Rule Added: ${rule.ruleId}`, output: formatRule(rule), metadata: { rule } };
      }
      if (action === 'deactivate') {
        if (!args.ruleId) throw new Error('ruleId is required to deactivate an AgentBook rule');
        await rulesStore.deactivateRule(args.ruleId);
        return {
          title: `AgentBook Rule Deactivated: ${args.ruleId}`,
          output: `Deactivated AgentBook rule ${args.ruleId}.`,
          metadata: { ruleId: args.ruleId, active: false },
        };
      }
      const rules = await rulesStore.listRules({ scope: args.scope, active: args.active });
      return {
        title: `AgentBook Rules: ${rules.length}`,
        output: rules.length > 0 ? rules.map(formatRule).join('\n\n') : 'No AgentBook rules matched.',
        metadata: { count: rules.length, rules },
      };
    },
  });
}

export function createAgentBookTools(deps: AgentBookToolDeps) {
  return {
    csm_agentbook_events: agentBookEventsTool(deps.eventStore),
    csm_agentbook_state: agentBookStateTool(deps),
    csm_agentbook_rule: agentBookRuleTool(deps.rulesStore),
  };
}

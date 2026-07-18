/**
 * Goal Tools — explicit goal tracking for sessions.
 *
 * Three tools: goal_set (create/update active goal), goal_update
 * (change status or description), goal_list (query history).
 */
import { tool } from '@opencode-ai/plugin/tool';
import { DatabasePool } from './types.js';
import {
  setActiveGoal, getActiveGoal, listGoals,
} from './goal-schema.js';
import { updateGoalForSession } from './goal-ownership.js';

export interface GoalToolDeps {
  pool: DatabasePool;
}

export function goalSetTool(deps: GoalToolDeps) {
  return tool({
    description:
      'Set the current active goal for this session. Replaces any previous active goal. ' +
      'The goal is visible in the system prompt and persists across tool calls within the session.',
    args: {
      description: tool.schema
        .string()
        .describe('Clear, specific description of the goal'),
      context: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe('Optional metadata (files, constraints, etc.)'),
    },
    async execute({ description, context }, ctx) {
      const goal = await setActiveGoal(
        deps.pool, ctx.sessionID, description, context as Record<string, unknown> | undefined,
      );
      return {
        title: `goal_set: ${goal.id.slice(0, 8)}`,
        output: [
          `Goal set: ${goal.description}`,
          `ID: ${goal.id}`,
          `Status: ${goal.status}`,
          `Created: ${new Date(Number(goal.created_at)).toISOString()}`,
        ].join('\n'),
        metadata: { goalId: goal.id, status: goal.status, description: goal.description },
      };
    },
  });
}

export function goalUpdateTool(deps: GoalToolDeps) {
  return tool({
    description:
      'Update the current active goal — change its description, mark it achieved or abandoned, ' +
      'or update its context metadata.',
    args: {
      goalId: tool.schema
        .string()
        .optional()
        .describe('Goal ID to update (defaults to current active goal)'),
      description: tool.schema
        .string()
        .optional()
        .describe('New description for the goal'),
      status: tool.schema
        .enum(['active', 'achieved', 'abandoned'])
        .optional()
        .describe('New status: active, achieved, or abandoned'),
      context: tool.schema
        .record(tool.schema.string(), tool.schema.unknown())
        .optional()
        .describe('Merge into existing context metadata'),
    },
    async execute({ goalId, description, status, context }, ctx) {
      let id = goalId;
      if (!id) {
        const active = await getActiveGoal(deps.pool, ctx.sessionID);
        if (!active) {
          return {
            title: 'goal_update: (no active goal)',
            output: 'No active goal found. Use goal_set to create one.',
            metadata: { found: false },
          };
        }
        id = active.id;
      }

      const patch: { description?: string; status?: 'active' | 'achieved' | 'abandoned'; context?: Record<string, unknown> } = {};
      if (description !== undefined) patch.description = description;
      if (status !== undefined) patch.status = status;
      if (context !== undefined) patch.context = context as Record<string, unknown>;

      const updated = await updateGoalForSession(deps.pool, id, ctx.sessionID, patch);
      if (!updated) {
        return {
          title: `goal_update: ${id.slice(0, 8)} (not found)`,
          output: `No goal with ID "${id}"`,
          metadata: { found: false, goalId: id },
        };
      }
      return {
        title: `goal_update: ${updated.id.slice(0, 8)} → ${updated.status}`,
        output: [
          `Goal updated: ${updated.description}`,
          `Status: ${updated.status}`,
          updated.achieved_at
            ? `Completed: ${new Date(Number(updated.achieved_at)).toISOString()}`
            : null,
        ].filter(Boolean).join('\n'),
        metadata: { goalId: updated.id, status: updated.status },
      };
    },
  });
}

export function goalListTool(deps: GoalToolDeps) {
  return tool({
    description:
      'List goals for this session. Shows active goal first, then recent history.',
    args: {
      status: tool.schema
        .string()
        .optional()
        .describe('Filter by status: active, achieved, abandoned (default: all)'),
      limit: tool.schema
        .number()
        .optional()
        .describe('Max results (default 10, max 50)'),
    },
    async execute({ status, limit }, ctx) {
      const goals = await listGoals(deps.pool, ctx.sessionID, {
        status,
        limit: Math.min(limit ?? 10, 50),
      });
      if (goals.length === 0) {
        return {
          title: 'goal_list (empty)',
          output: 'No goals found. Use goal_set to create one.',
          metadata: { count: 0 },
        };
      }
      const lines = goals.map((g) => {
        const ts = new Date(Number(g.created_at)).toISOString();
        const mark = g.status === 'active' ? '●' : g.status === 'achieved' ? '✓' : '✗';
        return `${mark} [${g.id.slice(0, 8)}] ${g.description} (${g.status}, ${ts})`;
      });
      return {
        title: `goal_list (${goals.length})`,
        output: lines.join('\n'),
        metadata: {
          count: goals.length,
          goals: goals.map((g) => ({
            id: g.id,
            description: g.description,
            status: g.status,
            createdAt: new Date(g.created_at).toISOString(),
          })),
        },
      };
    },
  });
}

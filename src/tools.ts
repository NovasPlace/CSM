// Custom tools for memory management
// Tools: memory_save, memory_search, memory_list, memory_delete, memory_context, memory_lesson

import { tool } from '@opencode-ai/plugin/tool';
import { MemoryManager } from './memory-manager.js';
import { ContextRecallDaemon } from './context-recall.js';
import { PrimingEngine } from './priming-engine.js';
import { MemoryType, MemoryApproval } from './types.js';
import { MemoryExtractor } from './memory-extractor.js';
import { ToolCallDistiller } from './tool-distiller.js';
import { ContextCompactor } from './context-compactor.js';
import { Database } from './database.js';
import type { Redactor } from './redactor.js';
import { listMemoriesOp, saveMemoryOp, searchMemoriesOp } from './bridge-ops.js';
import { RecallQualityAuditReportBuilder, validateRecallQualityAuditParams } from './recall-quality-tool.js';
import { CSM_TOOL_NAMES } from './tool-names.js';

/**
 * memory_save - Save information to cross-session memory
 */
export function memorySaveTool(memoryManager: MemoryManager) {
  return tool({
    description: 'Save information to cross-session memory. Use this to remember important decisions, context, or preferences across conversations.',
    args: {
      content: tool.schema.string().describe('Content to remember'),
      type: tool.schema.enum(['conversation', 'workspace', 'repo', 'preference', 'lesson']).describe('Type of memory'),
      importance: tool.schema.number().optional().describe('Importance 0-1 (default 0.5, lessons default to 0.75)'),
      tags: tool.schema.array(tool.schema.string()).optional().describe('Tags for categorization'),
      linkedMemoryIds: tool.schema.array(tool.schema.number()).optional().describe('IDs of related memories to link'),
    },
    async execute(args, context) {
      const memory = await saveMemoryOp({
        memoryManager,
        contextRecall: undefined as never,
        primingEngine: undefined as never,
        contextCompactor: undefined as never,
      }, {
        content: args.content,
        type: args.type as MemoryType,
        importance: args.type === 'lesson' ? 0.75 : args.importance,
        emotion: args.type === 'lesson' ? 'frustration' : 'neutral',
        source: args.type === 'lesson' ? 'lesson' : 'manual',
        tags: args.tags,
        linkedMemoryIds: args.linkedMemoryIds,
        sessionId: context.sessionID,
      });

      return {
        title: 'Memory Saved',
        output: `Saved memory #${memory.id}: ${args.content.substring(0, 100)}${args.content.length > 100 ? '...' : ''}`,
        metadata: {
          memoryId: memory.id,
          type: args.type,
          importance: memory.importance,
        },
      };
    },
  });
}

/**
 * memory_search - Search memories using semantic similarity
 */
export function memorySearchTool(memoryManager: MemoryManager, primingEngine: PrimingEngine) {
  return tool({
    description: 'Search cross-session memories using semantic similarity when prior context would materially help answer the user. Do not use for simple greetings or small talk.',
    args: {
      query: tool.schema.string().describe('Search query'),
      type: tool.schema.enum(['conversation', 'workspace', 'repo', 'preference', 'lesson']).optional().describe('Filter by memory type'),
      limit: tool.schema.number().optional().describe('Max results (default 10)'),
      minImportance: tool.schema.number().optional().describe('Minimum importance 0-1'),
    },
    async execute(args, context) {
      const { results, cascaded } = await searchMemoriesOp({
        memoryManager,
        primingEngine,
        contextRecall: undefined as never,
        contextCompactor: undefined as never,
      }, {
        query: args.query,
        type: args.type as MemoryType | undefined,
        limit: args.limit ?? 10,
        minImportance: args.minImportance,
      }, {
        sessionId: context.sessionID,
      });

      // Format output
      let output = `Found ${results.length} relevant memories:\n\n`;
      
      for (const result of results) {
        const { memory, score } = result;
        const preview = memory.content.substring(0, 150).replace(/\n/g, ' ');
        output += `#${memory.id} [${memory.memoryType}] (score: ${score.toFixed(2)})\n`;
        output += `  ${preview}${memory.content.length > 150 ? '...' : ''}\n`;
        output += `  Importance: ${memory.importance.toFixed(2)} | Accessed: ${memory.accessCount} times\n\n`;
      }

      if (cascaded.length > results.length) {
        output += `\n--- Related memories (via PrimingEngine cascade) ---\n`;
        for (const memory of cascaded.slice(results.length, results.length + 5)) {
          const preview = memory.content.substring(0, 100).replace(/\n/g, ' ');
          output += `#${memory.id} [${memory.memoryType}] ${preview}\n`;
        }
      }

      return {
        title: 'Memory Search Results',
        output,
        metadata: {
          count: results.length,
          cascadedCount: cascaded.length,
          memories: results.map(r => ({ id: r.memory.id, score: r.score })),
        },
      };
    },
  });
}

/**
 * memory_delete - Delete a memory
 */
export function memoryDeleteTool(memoryManager: MemoryManager) {
  return tool({
    description: 'Delete a memory by ID.',
    args: {
      id: tool.schema.number().describe('Memory ID to delete'),
    },
    async execute(args, _context) {
      const deleted = await memoryManager.deleteMemory(args.id);

      if (deleted) {
        return {
          title: 'Memory Deleted',
          output: `Memory #${args.id} has been deleted.`,
          metadata: { deleted: true, memoryId: args.id },
        };
      } else {
        return {
          title: 'Memory Not Found',
          output: `Memory #${args.id} was not found.`,
          metadata: { deleted: false, memoryId: args.id },
        };
      }
    },
  });
}

/**
 * memory_context - Get current context brief
 */
export function memoryContextTool(contextRecall: ContextRecallDaemon) {
  return tool({
    description: 'Get the current context brief for this session when the user explicitly asks about memory or prior context. Do not use for simple greetings or small talk.',
    args: {},
    async execute(_args, _context) {
      const contextBrief = await contextRecall.getContextBrief();

      if (!contextBrief) {
        return {
          title: 'No Context Available',
          output: 'No context brief available for this session yet. The system will build one shortly.',
          metadata: { available: false },
        };
      }

      let output = '=== CROSS-SESSION MEMORY CONTEXT ===\n\n';

      // Distilled tool activity (shown first — highest signal)
      output += '## Recent Tool Activity (Distilled)\n';
      if (contextBrief.distilled && contextBrief.distilled.length > 0) {
        for (const group of contextBrief.distilled.slice(0, 6)) {
          const status =
            group.outcome === 'success' ? 'OK'
            : group.outcome === 'failure' ? 'FAIL'
            : group.outcome === 'partial' ? 'PARTIAL'
            : '?';
          const insight = group.proceduralInsight ?? group.intent;
          const preview = insight.substring(0, 80).replace(/\n/g, ' ');
          output += `- [${status}] ${preview}${insight.length > 80 ? '...' : ''}\n`;
        }
      } else {
        output += '- No distilled tool activity yet\n';
      }
      output += '\n';

      output += '## Episodic Memories (Recent Events)\n';
      if (contextBrief.episodic.length > 0) {
        for (const memory of contextBrief.episodic.slice(0, 5)) {
          const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
          output += `- ${preview}\n`;
        }
      } else {
        output += '- No recent events\n';
      }
      
      output += '\n## Procedural Memories (Lessons)\n';
      if (contextBrief.procedural.length > 0) {
        for (const memory of contextBrief.procedural.slice(0, 5)) {
          const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
          output += `- [${memory.emotion}] ${preview}\n`;
        }
      } else {
        output += '- No lessons learned\n';
      }
      
      output += '\n## Semantic Memories (Project Context)\n';
      if (contextBrief.semantic.length > 0) {
        for (const memory of contextBrief.semantic.slice(0, 5)) {
          const preview = memory.content.substring(0, 80).replace(/\n/g, ' ');
          output += `- [${memory.memoryType}] ${preview}\n`;
        }
      } else {
        output += '- No project context\n';
      }

      return {
        title: 'Context Brief',
        output,
        metadata: {
          available: true,
          distilledCount: contextBrief.distilled?.length ?? 0,
          episodicCount: contextBrief.episodic.length,
          proceduralCount: contextBrief.procedural.length,
          semanticCount: contextBrief.semantic.length,
        },
      };
    },
  });
}

/**
 * memory_lesson - Save a lesson learned
 */
export function memoryLessonTool(memoryManager: MemoryManager) {
  return tool({
    description: 'Save a lesson learned from a mistake. Lessons are stored with high importance and "frustration" emotion for better recall. Optionally specify triggerPatterns to make the lesson fire contextually when matching tools/files are used.',
    args: {
      content: tool.schema.string().describe('What was learned — be actionable: say what TO do, not just what happened. E.g. "Use the Edit tool instead of PowerShell .Replace() on .ts files" not "PowerShell replace failed"'),
      frustration: tool.schema.number().optional().describe('Frustration level 0-1 (default 0.7)'),
      triggerTools: tool.schema.array(tool.schema.string()).optional().describe('Tool names that trigger this lesson (e.g. ["bash", "edit"])'),
      triggerFiles: tool.schema.array(tool.schema.string()).optional().describe('File extensions that trigger this lesson (e.g. [".ts", ".js"])'),
      triggerArgPatterns: tool.schema.record(tool.schema.string(), tool.schema.string()).optional().describe('Arg regex patterns that trigger this lesson (e.g. {"command": "\\\\.Replace\\\\("})'),
    },
    async execute(args, context) {
      const triggerMeta: Record<string, unknown> = {};
      if (args.triggerTools?.length) triggerMeta.tools = args.triggerTools;
      if (args.triggerFiles?.length) triggerMeta.files = args.triggerFiles;
      if (args.triggerArgPatterns && Object.keys(args.triggerArgPatterns).length > 0) triggerMeta.args = args.triggerArgPatterns;

      const metadata: Record<string, unknown> = {
        frustration: args.frustration ?? 0.7,
      };
      if (Object.keys(triggerMeta).length > 0) {
        metadata.triggers = triggerMeta;
      }

      const tags = ['lesson', 'learned'];
      for (const t of args.triggerTools ?? []) tags.push(`tool:${t}`);

      const memory = await memoryManager.saveMemory({
        content: args.content,
        type: 'lesson',
        importance: 0.75,
        emotion: 'frustration',
        confidence: 0.9,
        source: 'lesson',
        tags,
        metadata,
        sessionId: context.sessionID,
      });

      const triggerNote = Object.keys(triggerMeta).length > 0
        ? `\nTrigger patterns saved: ${JSON.stringify(triggerMeta)}`
        : '\nNo trigger patterns specified — lesson will match broadly.';

      return {
        title: 'Lesson Saved',
        output: `Lesson #${memory.id} saved: ${args.content.substring(0, 100)}${args.content.length > 100 ? '...' : ''}${triggerNote}\n\nThis lesson will fire contextually when matching tools/files are used.`,
        metadata: {
          memoryId: memory.id,
          importance: memory.importance,
          emotion: memory.emotion,
        },
      };
    },
  });
}

/**
 * memory_list - List memories with filters
 */
export function memoryListTool(memoryManager: MemoryManager) {
  return tool({
    description: 'List memories with optional filtering by session, type, tags, entities, and date range when the user asks to inspect memory. Do not use for simple greetings or small talk.',
    args: {
      sessionId: tool.schema.string().optional().describe('Filter by session ID'),
      projectId: tool.schema.string().optional().describe('Filter by project ID'),
      type: tool.schema.enum(['conversation', 'workspace', 'repo', 'preference', 'lesson', 'episodic', 'procedural']).optional().describe('Filter by memory type'),
      tags: tool.schema.array(tool.schema.string()).optional().describe('Filter by tags (AND)'),
      entityType: tool.schema.enum(['file', 'function', 'error', 'decision', 'tool', 'concept', 'dependency']).optional().describe('Filter by extracted entity type'),
      entityValue: tool.schema.string().optional().describe('Filter by specific entity value'),
      startDate: tool.schema.string().optional().describe('Filter memories after this date (ISO 8601)'),
      endDate: tool.schema.string().optional().describe('Filter memories before this date (ISO 8601)'),
      sortBy: tool.schema.enum(['recent', 'important', 'accessed']).optional().describe('Sort order (default: recent)'),
      limit: tool.schema.number().optional().describe('Max results (default 20, max 100)'),
    },
    async execute(args, context) {
      const memories = await listMemoriesOp({
        memoryManager,
        contextRecall: undefined as never,
        primingEngine: undefined as never,
        contextCompactor: undefined as never,
      }, {
        sessionId: args.sessionId,
        projectId: args.projectId,
        type: args.type as MemoryType | undefined,
        tags: args.tags,
        entityType: args.entityType,
        entityValue: args.entityValue,
        dateFrom: args.startDate ? new Date(args.startDate) : undefined,
        dateTo: args.endDate ? new Date(args.endDate) : undefined,
        sortBy: args.sortBy,
        limit: Math.min(args.limit ?? 20, 100),
      }, {
        sessionId: context.sessionID,
      });

      if (memories.length === 0) {
        return {
          title: 'No Memories Found',
          output: 'No memories match the specified filters.',
          metadata: { count: 0 },
        };
      }

      let output = `Found ${memories.length} memories:\n\n`;
      for (const m of memories) {
        const date = new Date(m.createdAt).toLocaleString();
        const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
        const concepts = (m.metadata as { extracted_concepts?: { type: string; value: string }[] })?.extracted_concepts ?? [];
        const conceptStr = concepts.length ? ` | ${concepts.map(c => `${c.type}:${c.value}`).join(', ')}` : '';
        output += `#${m.id} ${m.memoryType} (${m.importance.toFixed(2)})${tags}${conceptStr}\n  ${date} — ${m.content.substring(0, 120)}${m.content.length > 120 ? '...' : ''}\n\n`;
      }

      return {
        title: 'Memory List',
        output,
        metadata: { count: memories.length },
      };
    },
  });
}

/**
 * memory_transcript - Get full conversation transcript
 */
export function memoryTranscriptTool(memoryManager: MemoryManager) {
  return tool({
    description: 'Get full conversation transcript from a session. Requires fullTranscripts config to be enabled.',
    args: {
      sessionId: tool.schema.string().optional().describe('Session ID (defaults to current session)'),
      limit: tool.schema.number().optional().describe('Max messages to return (default 50)'),
      role: tool.schema.enum(['user', 'assistant', 'all']).optional().describe('Filter by role (default all)'),
    },
    async execute(args, context) {
      const sessionId = args.sessionId ?? context.sessionID;
      
      if (!sessionId) {
        return {
          title: 'No Session',
          output: 'No session ID provided and no current session available.',
          metadata: { error: 'no_session' },
        };
      }

      // Get conversation memories for this session
      const memories = await memoryManager.listMemories({
        type: 'conversation',
        limit: args.limit ?? 100,
        sortBy: 'recent',
      });

      // Filter by session and role
      const transcript = memories
        .filter(m => m.sessionId === sessionId)
        .filter(m => {
          if (args.role === 'all' || !args.role) return true;
          const role = m.metadata?.role as string;
          return role === args.role;
        })
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      if (transcript.length === 0) {
        return {
          title: 'No Transcript',
          output: 'No transcript found for this session. Make sure fullTranscripts is enabled in config.',
          metadata: { count: 0, sessionId },
        };
      }

      // Format transcript
      let output = `=== Conversation Transcript (${transcript.length} messages) ===\n\n`;
      
      for (const memory of transcript) {
        const role = (memory.metadata?.role as string) ?? 'unknown';
        const prefix = role === 'user' ? 'USER' : role === 'assistant' ? 'ASSISTANT' : role.toUpperCase();
        output += `[${prefix}]: ${memory.content}\n\n`;
      }

      return {
        title: 'Conversation Transcript',
        output,
        metadata: {
          count: transcript.length,
          sessionId,
          roles: [...new Set(transcript.map(m => m.metadata?.role as string))],
        },
      };
    },
  });
}

/**
 * memory_candidate_list - List pending memory candidates for review
 */
export function memoryCandidateListTool(memoryExtractor: MemoryExtractor) {
  return tool({
    description: 'List pending memory candidates awaiting review/approval.',
    args: {
      sessionId: tool.schema.string().optional().describe('Filter by session ID'),
      limit: tool.schema.number().optional().describe('Max results (default 50)'),
    },
    async execute(args, _context) {
      const candidates = await memoryExtractor.getPendingCandidates(args.sessionId, args.limit ?? 50);

      let output = `Found ${candidates.length} pending candidates:\n\n`;

      for (const candidate of candidates) {
        const preview = candidate.content.substring(0, 150).replace(/\n/g, ' ');
        output += `#${candidate.id} [${candidate.proposedType}] (confidence: ${candidate.confidence.toFixed(2)})\n`;
        output += `  ${preview}${candidate.content.length > 150 ? '...' : ''}\n`;
        output += `  Importance: ${candidate.importance.toFixed(2)} | Status: ${candidate.status}\n\n`;
      }

      return {
        title: 'Memory Candidates',
        output,
        metadata: {
          count: candidates.length,
          candidates: candidates.map(c => ({ id: c.id, type: c.proposedType, status: c.status })),
        },
      };
    },
  });
}

/**
 * memory_candidate_approve - Approve a memory candidate
 */
export function memoryCandidateApproveTool(memoryExtractor: MemoryExtractor) {
  return tool({
    description: 'Approve a pending memory candidate, optionally with edits.',
    args: {
      id: tool.schema.string().describe('Candidate ID to approve'),
      editedContent: tool.schema.string().optional().describe('Edited content (optional)'),
      editedType: tool.schema.enum(['conversation', 'workspace', 'repo', 'preference', 'lesson', 'episodic', 'procedural']).optional().describe('Edited type (optional)'),
      editedImportance: tool.schema.number().optional().describe('Edited importance 0-1 (optional)'),
      editedTags: tool.schema.array(tool.schema.string()).optional().describe('Edited tags (optional)'),
    },
    async execute(args, _context) {
      const approval: MemoryApproval = {
        candidateId: args.id,
        action: 'approve',
        editedContent: args.editedContent,
        editedType: args.editedType as MemoryType | undefined,
        editedImportance: args.editedImportance,
        editedTags: args.editedTags,
        reviewedBy: 'user',
        reviewedAt: new Date(),
      };

      await memoryExtractor.reviewCandidate(approval, 'user');

      return {
        title: 'Candidate Approved',
        output: `Candidate #${args.id} has been approved and saved as a memory.`,
        metadata: { approved: true, candidateId: args.id },
      };
    },
  });
}

/**
 * memory_candidate_reject - Reject a memory candidate
 */
export function memoryCandidateRejectTool(memoryExtractor: MemoryExtractor) {
  return tool({
    description: 'Reject a pending memory candidate.',
    args: {
      id: tool.schema.string().describe('Candidate ID to reject'),
    },
    async execute(args, _context) {
      const approval: MemoryApproval = {
        candidateId: args.id,
        action: 'reject',
        reviewedBy: 'user',
        reviewedAt: new Date(),
      };

      await memoryExtractor.reviewCandidate(approval, 'user');

      return {
        title: 'Candidate Rejected',
        output: `Candidate #${args.id} has been rejected.`,
        metadata: { rejected: true, candidateId: args.id },
      };
    },
  });
}

/**
 * memory_project_list - List all project scopes
 */
export function memoryProjectListTool(memoryManager: MemoryManager) {
  return tool({
    description: 'List all project scopes with memory counts.',
    args: {},
    async execute(_args, _context) {
      const projects = await memoryManager.getAllProjectScopes();

      let output = `Found ${projects.length} projects:\n\n`;

      for (const project of projects) {
        output += `#${project.project_id} - ${project.name}\n`;
        output += `  Directory: ${project.directory}\n`;
        output += `  Memories: ${project.memory_count} | Last active: ${project.last_active_at}\n\n`;
      }

      return {
        title: 'Project Scopes',
        output,
        metadata: { count: projects.length, projects },
      };
    },
  });
}

/**
 * memory_cleanup - Run cleanup of expired memories and candidates
 */
export function memoryCleanupTool(memoryManager: MemoryManager) {
  return tool({
    description: 'Run cleanup of expired memories and candidates based on TTL config.',
    args: {},
    async execute(_args, _context) {
      const result = await memoryManager.cleanupExpiredMemories();

      return {
        title: 'Cleanup Complete',
        output: `Cleanup complete: ${result.deleted} memories deleted, ${result.archived} memories archived.`,
        metadata: { deleted: result.deleted, archived: result.archived },
      };
    },
  });
}

/**
 * memory_distill - Distill buffered tool calls into a structured summary
 * Groups consecutive tool calls by intent, extracts outcome/files/errors,
 * persists the summary, and feeds it into the memory extractor.
 */
export function memoryDistillTool(
  distiller: ToolCallDistiller,
  database: Database,
  extractor: MemoryExtractor,
  redactor?: Redactor,
) {
  return tool({
    description:
      'Distill recent tool-call activity into a structured summary. Groups consecutive tool calls by intent, extracts files changed, errors, and fixes applied. The summary appears in the context pane and feeds procedural/lesson memories.',
    args: {
      persist: tool.schema.boolean().optional().describe(
        'Persist the distilled summary to the database (default true)',
      ),
      extractMemories: tool.schema.boolean().optional().describe(
        'Feed distilled groups into the memory extractor as candidates (default true)',
      ),
    },
    async execute(args, context) {
      const summary = distiller.distill();

      const shouldPersist = args.persist ?? true;
      const shouldExtract = args.extractMemories ?? true;

      if (shouldPersist && context.sessionID && summary.groups.length > 0) {
        const pool = database.getPool();
        const groupsJson = JSON.stringify(summary.groups);
        const compressedText = redactor
          ? redactor.redact(summary.compressed).text
          : summary.compressed;
        const groupsText = redactor
          ? redactor.redact(groupsJson).text
          : groupsJson;
        await pool.query(
          `INSERT INTO distilled_summaries (id, session_id, groups, compressed, total_calls_summarized)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (session_id, md5(compressed)) DO NOTHING`,
          [
            summary.id,
            context.sessionID,
            groupsText,
            compressedText,
            summary.totalCallsSummarized,
          ],
        );
      }

      let extractedCount = 0;
      if (shouldExtract && context.sessionID && summary.groups.length > 0) {
        const candidates = await extractor.extractFromDistilledSummaries(
          context.sessionID,
          context.sessionID,
          summary,
        );
        extractedCount = candidates.length;
      }

      return {
        title: 'Tool Calls Distilled',
        output: summary.compressed +
          (extractedCount > 0 ? `\n\nExtracted ${extractedCount} memory candidates from distilled activity.` : ''),
        metadata: {
          summaryId: summary.id,
          groupsCount: summary.groups.length,
          totalCallsSummarized: summary.totalCallsSummarized,
          extractedCandidates: extractedCount,
          persisted: shouldPersist,
        },
      };
    },
  });
}

/**
 * memory_distilled_view - View recent distilled tool-call summaries
 */
export function memoryDistilledViewTool(database: Database) {
  return tool({
    description:
      'View recent distilled tool-call summaries for the current session. Shows the compressed activity log that appears in the context pane.',
    args: {
      limit: tool.schema.number().optional().describe('Max summaries to return (default 5)'),
    },
    async execute(args, context) {
      if (!context.sessionID) {
        return {
          title: 'No Session',
          output: 'No active session to query distilled summaries for.',
          metadata: { error: 'no_session' },
        };
      }

      const pool = database.getPool();
      const limit = args.limit ?? 5;

      const result = await pool.query(
        `SELECT id, compressed, total_calls_summarized, built_at
         FROM distilled_summaries
         WHERE session_id = $1
         ORDER BY built_at DESC
         LIMIT $2`,
        [context.sessionID, limit],
      );

      if (result.rows.length === 0) {
        return {
          title: 'No Distilled Summaries',
          output: 'No distilled tool-call summaries found for this session yet. Use memory_distill to generate one.',
          metadata: { count: 0 },
        };
      }

      let output = `=== Distilled Tool Activity (${result.rows.length} summaries) ===\n\n`;

      for (const row of result.rows) {
        const r = row as Record<string, unknown>;
        const builtAt = r.built_at as Date;
        const compressed = r.compressed as string;
        const calls = r.total_calls_summarized as number;
        output += `--- ${r.id} (${calls} calls, ${builtAt.toISOString()}) ---\n`;
        output += `${compressed}\n\n`;
      }

      return {
        title: 'Distilled Summaries',
        output,
        metadata: {
          count: result.rows.length,
          summaries: result.rows.map((r) => ({
            id: (r as Record<string, unknown>).id,
            calls: (r as Record<string, unknown>).total_calls_summarized,
          })),
        },
      };
    },
  });
}

/**
 * memory_compact - Report on context compaction token savings
 * Shows the last compaction result: how many tool parts were compacted
 * and how many tokens were saved by replacing raw tool output with distilled references.
 */
export function memoryCompactTool(contextCompactor: ContextCompactor) {
  return tool({
    description:
      'Report on context compaction: last compaction result plus cumulative session savings. Shows how many tool-call outputs were replaced with distilled references and how many tokens were saved.',
    args: {},
    async execute(_args, _context) {
      const result = contextCompactor.getLastResult();
      const cumulative = contextCompactor.getCumulativeStats();

      if (!result) {
        return {
          title: 'No Compaction Yet',
          output: 'No compaction has run yet. Compaction happens automatically on each message transform when tool-call history accumulates.',
          metadata: { available: false, cumulative },
        };
      }

      let output = '=== CONTEXT COMPACTION REPORT ===\n\n';
      output += '## Last Compaction\n';
      output += `Tool parts total:     ${result.totalToolParts}\n`;
      output += `Compacted (replaced): ${result.compactedParts}\n`;
      output += `Kept raw (working):   ${result.keptRawParts}\n`;
      output += `Skipped (recent/already compacted): ${result.skippedParts}\n\n`;
      output += `Before: ~${result.beforeTokens} tokens (${result.beforeChars} chars)\n`;
      output += `After:  ~${result.afterTokens} tokens (${result.afterChars} chars)\n`;
      output += `Saved:  ~${result.tokensSaved} tokens (${result.savedPercent}%)\n`;
      output += `Time:   ${result.compactedAt.toISOString()}\n\n`;

      output += '## Cumulative Session Savings\n';
      output += `Total compactions:    ${cumulative.totalCompactions}\n`;
      output += `Total parts compacted: ${cumulative.totalPartsCompacted}\n`;
      output += `Total tokens saved:   ~${cumulative.totalTokensSaved}\n`;
      if (cumulative.firstCompactedAt) {
        output += `First compaction:     ${cumulative.firstCompactedAt.toISOString()}\n`;
        output += `Last compaction:      ${cumulative.lastCompactedAt?.toISOString() ?? 'n/a'}\n`;
      }

      return {
        title: 'Compaction Report',
        output,
        metadata: {
          available: true,
          totalToolParts: result.totalToolParts,
          compactedParts: result.compactedParts,
          keptRawParts: result.keptRawParts,
          tokensSaved: result.tokensSaved,
          savedPercent: result.savedPercent,
          cumulative,
        },
      };
    },
  });
}

/**
 * csm_runtime_status - Diagnostic tool to verify plugin tool exposure
 */
export function runtimeStatusTool(
  database: Database,
  memoryManager: MemoryManager,
  config: { fullTranscripts?: boolean },
  currentSessionId: string | null,
) {
  return tool({
    description: 'Diagnostic tool to verify cross-session memory plugin runtime status, tool registration, and database connectivity.',
    args: {},
    async execute(args, context) {
      let databaseConnected = false;
      let postgresMemoryCount = 0;
      
      try {
        const pool = database.getPool();
        databaseConnected = true;
        const countResult = await pool.query('SELECT COUNT(*) as count FROM memories');
        postgresMemoryCount = parseInt((countResult.rows[0] as Record<string, unknown>).count as string, 10);
      } catch {
        databaseConnected = false;
      }

      return {
        title: 'CSM Runtime Status',
        output: JSON.stringify({
          plugin_loaded: true,
          database_connected: databaseConnected,
          registered_csm_tools: CSM_TOOL_NAMES,
          tool_namespace: 'csm_',
          postgres_memory_count: postgresMemoryCount,
          current_session_id: context.sessionID ?? currentSessionId,
          memory_runtime_enabled: config.fullTranscripts ?? true,
        }, null, 2),
        metadata: {
          plugin_loaded: true,
          database_connected: databaseConnected,
          registered_csm_tools: CSM_TOOL_NAMES,
          tool_namespace: 'csm_',
          postgres_memory_count: postgresMemoryCount,
          current_session_id: context.sessionID ?? currentSessionId,
          memory_runtime_enabled: config.fullTranscripts ?? true,
        },
      };
    },
  });
}

export function compactionAuditTool(database: Database) {
  return tool({
    description: 'Audit compaction telemetry for correctness. Recomputes totals from raw before/after values, checks for duplicates, negative values, math errors, and zero fields. Verifies SUM(tokens_saved) matches SUM(before_tokens - after_tokens).',
    args: {},
    async execute() {
      const { auditCompactionTelemetry, formatAuditReport } = await import('./compaction-telemetry-audit.js');
      const result = await auditCompactionTelemetry(database.getPool());
      return {
        title: result.passed ? 'Compaction Audit PASSED' : 'Compaction Audit ISSUES FOUND',
        output: formatAuditReport(result),
        metadata: result,
      };
    },
  });
}

/**
 * csm_recall_quality_report - Read-only audit of recall quality
 * Phase 6B: Report-only, no scoring. PG-specific (SQLite degrades to N/A).
 */
export function recallQualityReportTool(database: Database) {
  return tool({
    description:
      'Produce a read-only audit of recall quality metrics over a time window. Report-only (Phase 6B). PG-specific SQL (SQLite degrades to N/A).',
    args: {
      scope: tool.schema.enum(['project', 'session', 'file']).optional().describe(
        'Filter scope: project (default), session, or file',
      ),
      projectId: tool.schema.string().optional().describe(
        'Project ID to filter (required when scope=project and you want a specific project)',
      ),
      sessionId: tool.schema.string().optional().describe(
        'Session ID to filter (required when scope=session)',
      ),
      filePath: tool.schema.string().optional().describe(
        'File path to filter (required when scope=file)',
      ),
      since: tool.schema.string().optional().describe(
        'ISO date string for window start (default: 24h ago)',
      ),
      limit: tool.schema.number().optional().describe(
        'Max recall events to scan per metric (default 1000, max 10000)',
      ),
    },
    async execute(args) {
      const params = {
        scope: args.scope,
        projectId: args.projectId,
        sessionId: args.sessionId,
        filePath: args.filePath,
        since: args.since,
        limit: args.limit,
      };

      try {
        validateRecallQualityAuditParams(params);
      } catch (e) {
        return {
          title: 'Invalid Parameters',
          output: `Parameter validation failed: ${(e as Error).message}`,
          metadata: { error: 'invalid_params', message: (e as Error).message },
        };
      }

      const builder = new RecallQualityAuditReportBuilder(database.getPool());
      const report = await builder.generateReport(params);

      return {
        title: 'Recall Quality Report',
        output: report,
        metadata: {
          scope: params.scope || 'project',
          since: params.since || '24h',
          limit: params.limit || 1000,
        },
      };
    },
  });
}

/**
 * csm_memory_related - Surface memories linked to a given memory via the graph.
 * Records graph-source recall telemetry (Phase 6C Hook 4).
 */
export function memoryRelatedTool(database: Database) {
  return tool({
    description: 'List memories linked to a given memory ID via the memory graph (memory_links). Read-only; records graph recall telemetry.',
    args: {
      memoryId: tool.schema.number().describe('Memory ID to find related memories for'),
      limit: tool.schema.number().optional().describe('Max related memories to return (default 10)'),
    },
    async execute(args, context) {
      const { getRelatedMemories } = await import('./memory-graph.js');
      const related = await getRelatedMemories(
        database,
        args.memoryId,
        args.limit ?? 10,
        { sessionId: context.sessionID, projectId: (context as { projectId?: string })?.projectId },
      );
      const memories = related.map((r) => r.memory);

      const lines = memories.map((m, i) =>
        `${i + 1}. [${m.id}] ${m.memoryType} (imp ${m.importance?.toFixed?.(2) ?? '?'}) ${m.content.slice(0, 120)}`,
      );
      return {
        title: `Related to memory ${args.memoryId}`,
        output: memories.length > 0 ? lines.join('\n') : 'No linked memories found.',
        metadata: { memoryId: args.memoryId, count: memories.length },
      };
    },
  });
}

/**
 * csm_continuity_report - Read-only resilience dashboard over the full CSM stack.
 * Phase 6E: Reports health of memory, recall, graph, pipeline, living state, docs, tools.
 * Phase 6F: Adds compact/full modes, JSON format, snapshot save/load, and run comparison.
 * No mutations. No repairs. No auto-action.
 */
export function continuityReportTool(database: Database) {
  return tool({
    description:
      'Produce a read-only continuity resilience report covering memory inventory, recall health, graph readiness, pipeline status, living state, docs freshness, tool registry, advisories, and overall confidence. Advisory only — no mutations.',
    args: {
      windowHours: tool.schema.number().optional().describe(
        'Time window in hours for recall health metrics (default 24)',
      ),
      mode: tool.schema.enum(['compact', 'full']).optional().describe(
        'Output mode: compact (exec summary + key metrics) or full (all sections). Default: full',
      ),
      format: tool.schema.enum(['text', 'json']).optional().describe(
        'Output format: text (human-readable) or json (for dashboards). Default: text',
      ),
      snapshot: tool.schema.boolean().optional().describe(
        'Save a snapshot of this report to .csm/continuity-snapshot.json for comparison on next run. Default: false',
      ),
      compare: tool.schema.boolean().optional().describe(
        'Compare against the previous snapshot if one exists. Shows deltas for score, memory total, recall events, graph coverage, pipeline activity, and section grades. Default: false',
      ),
    },
    async execute(args, context) {
      const { buildContinuityResilienceReport, buildContinuityReportWithOptions } = await import('./continuity-resilience-report.js');
      const workspaceDir = (context as { worktree?: string }).worktree || process.cwd();
      const toolMap: Record<string, unknown> = {};
      for (const name of CSM_TOOL_NAMES) toolMap[name] = true;
      const windowHours = args.windowHours ?? 24;
      const mode = args.mode ?? 'full';
      const format = args.format ?? 'text';
      const snapshot = args.snapshot ?? false;
      const compare = args.compare ?? false;

      // Use legacy path if no Phase 6F options are specified (backward compat)
      if (!args.mode && !args.format && !args.snapshot && !args.compare) {
        const report = await buildContinuityResilienceReport(database, workspaceDir, toolMap, windowHours);
        return {
          title: 'Continuity Resilience Report',
          output: report,
          metadata: { windowHours },
        };
      }

      const report = await buildContinuityReportWithOptions(database, workspaceDir, toolMap, windowHours, {
        mode, format, snapshot, compare, workspaceDir,
      });
      return {
        title: 'Continuity Resilience Report',
        output: report,
        metadata: { windowHours, mode, format, snapshot, compare },
      };
    },
  });
}

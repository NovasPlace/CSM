const sessionTool = { type: 'string', description: 'Optional bridge session id.' };
const projectTool = { type: 'string', description: 'Project root or identifier.' };
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
};

export const EXTRA_MCP_TOOLS = [
  toolSpec('memory_delete', 'Delete a memory by ID.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    id: { type: 'number', description: 'Memory ID to delete.' },
  }, ['id'], hints(false, false, true)),
  toolSpec('memory_context', 'Get a compact memory context brief.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    task: { type: 'string', description: 'Task or topic to prime for.', default: 'memory context' },
  }, [], hints(true, false, false)),
  toolSpec('memory_lesson', 'Save a lesson learned.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    content: { type: 'string', description: 'Lesson content.' },
    tags: { type: 'array', items: { type: 'string' }, description: 'Optional lesson tags.' },
    context: { type: 'object', description: 'Optional lesson context.' },
  }, ['content'], hints(false, false, false)),
  toolSpec('memory_transcript', 'Get the current conversation transcript for a session.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    limit: { type: 'number', description: 'Max messages to return.', default: 50 },
    role: { type: 'string', enum: ['user', 'assistant', 'all'], description: 'Filter by role.' },
  }, [], hints(true, false, false)),
  toolSpec('memory_candidate_list', 'List pending memory candidates for review.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    limit: { type: 'number', description: 'Max candidates to return.', default: 50 },
  }, [], hints(true, false, false)),
  toolSpec('memory_candidate_approve', 'Approve a pending memory candidate.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    id: { type: 'string', description: 'Candidate id.' },
    editedContent: { type: 'string', description: 'Optional edited content.' },
    editedType: { type: 'string', description: 'Optional edited memory type.' },
    editedImportance: { type: 'number', description: 'Optional edited importance.' },
    editedTags: { type: 'array', items: { type: 'string' }, description: 'Optional edited tags.' },
  }, ['id'], hints(false, false, false)),
  toolSpec('memory_candidate_reject', 'Reject a pending memory candidate.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    id: { type: 'string', description: 'Candidate id.' },
  }, ['id'], hints(false, false, true)),
  toolSpec('memory_project_list', 'List project scopes and memory counts.', {}, [], hints(true, false, false)),
  toolSpec('memory_cleanup', 'Run cleanup for expired memories and candidates.', {}, [], hints(false, false, true)),
  toolSpec('memory_distill', 'Distill an explicit tool-call snapshot into a structured summary.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    calls: { type: 'array', items: { type: 'object' }, description: 'Explicit tool-call records to distill.' },
    extractMemories: { type: 'boolean', description: 'Feed distilled groups into the memory extractor.', default: true },
  }, ['calls'], hints(false, false, false)),
  toolSpec('memory_distilled_view', 'View distilled tool-call summaries for a session.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    limit: { type: 'number', description: 'Max summaries to return.', default: 5 },
  }, [], hints(true, false, false)),
  toolSpec('memory_compact', 'Report the latest compaction result and cumulative stats.', {}, [], hints(true, false, false)),
  toolSpec('context_review', 'Review the most recent context compilation log entry.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    detail: { type: 'string', enum: ['summary', 'top', 'full'], description: 'How much detail to show.', default: 'summary' },
    limit: { type: 'number', description: 'Max entries for top mode.', default: 10 },
  }, [], hints(true, false, false)),
  toolSpec('context_fetch', 'Retrieve a cached context item by display id.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    id: { type: 'string', description: 'Cached display id.' },
  }, ['id'], hints(true, false, false)),
  toolSpec('context_search', 'Search cached context items by keyword.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    query: { type: 'string', description: 'Search query.' },
    limit: { type: 'number', description: 'Max results.', default: 10 },
  }, ['query'], hints(true, false, false)),
  toolSpec('context_fetch_file_region', 'Retrieve a cached file-read region.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    filePath: { type: 'string', description: 'Path of cached file.' },
    startLine: { type: 'number', description: 'First line to include.' },
    endLine: { type: 'number', description: 'Last line to include.' },
  }, ['filePath', 'startLine'], hints(true, false, false)),
  toolSpec('context_fetch_last_error', 'Retrieve the most recent cached error.', { sessionId: sessionTool, projectRoot: projectTool }, [], hints(true, false, false)),
  toolSpec('context_fetch_decision_log', 'Retrieve recent cached decisions.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    limit: { type: 'number', description: 'Max decisions.', default: 10 },
  }, [], hints(true, false, false)),
  toolSpec('goal_set', 'Set the active session goal.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    description: { type: 'string', description: 'Goal description.' },
    context: { type: 'object', description: 'Optional goal context.' },
  }, ['description'], hints(false, false, false)),
  toolSpec('goal_update', 'Update the active session goal.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    goalId: { type: 'string', description: 'Goal id.' },
    description: { type: 'string', description: 'Optional new description.' },
    status: { type: 'string', enum: ['active', 'achieved', 'abandoned'], description: 'Optional new status.' },
    context: { type: 'object', description: 'Optional context patch.' },
  }, [], hints(false, false, false)),
  toolSpec('goal_list', 'List goals for the current session.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    status: { type: 'string', description: 'Optional status filter.' },
    limit: { type: 'number', description: 'Max results.', default: 10 },
  }, [], hints(true, false, false)),
  toolSpec('create_checkpoint', 'Create a durable checkpoint from an explicit message snapshot.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    messages: { type: 'array', items: { type: 'object' }, description: 'Explicit message snapshot to checkpoint.' },
  }, ['messages'], hints(false, false, false)),
  toolSpec('memory_backfill_embeddings', 'Backfill missing embeddings for memories.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    limit: { type: 'number', description: 'Max rows to scan.', default: 25 },
    dryRun: { type: 'boolean', description: 'Preview only without writing embeddings.', default: false },
  }, ['limit'], hints(false, false, false)),
  toolSpec('list_checkpoints', 'List checkpoints for the current session.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    limit: { type: 'number', description: 'Max results.', default: 20 },
  }, [], hints(true, false, false)),
  toolSpec('expand_checkpoint_ref', 'Expand a checkpoint reference to recover raw content.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
    refId: { type: 'string', description: 'Reference id to expand.' },
  }, ['refId'], hints(true, false, false)),
  toolSpec('csm_context_pressure', 'Inspect context window pressure for an explicit message snapshot.', {
    messages: { type: 'array', items: { type: 'object' }, description: 'Message snapshot to estimate against.' },
    maxTokens: { type: 'number', description: 'Context window size.', default: 128000 },
    recommendThreshold: { type: 'number', description: 'Soft flush threshold from 0 to 1.', default: 0.65 },
    demandThreshold: { type: 'number', description: 'Hard flush threshold from 0 to 1.', default: 0.85 },
    nextTurnTokens: { type: 'number', description: 'Projected next-turn token growth.', default: 2000 },
  }, ['messages'], hints(true, false, false)),
  toolSpec('csm_context_budget', 'Inspect the context budget governor decision for prompt or shell evidence input.', {
    latestUserText: { type: 'string', description: 'Latest user/task text to classify.' },
    touchedFiles: { type: 'array', items: { type: 'string' }, description: 'Touched files to classify.' },
    isMayday: { type: 'boolean', description: 'Whether a Mayday condition is active.', default: false },
    finalProofRequired: { type: 'boolean', description: 'Whether full verification proof is required.', default: false },
    exactLineDebug: { type: 'boolean', description: 'Whether exact debugging lines are needed.', default: false },
    explicitRawOutputRequest: { type: 'boolean', description: 'Whether the caller explicitly wants raw output.', default: false },
    docSummaryAvailable: { type: 'boolean', description: 'Whether a doc summary already exists.', default: false },
    verificationBlocked: { type: 'boolean', description: 'Whether verification is blocked.', default: false },
    command: { type: 'string', description: 'Optional shell command to package.' },
    cwd: { type: 'string', description: 'Optional shell working directory.' },
    exitCode: { type: 'number', description: 'Optional shell exit code.', default: 0 },
    stdout: { type: 'string', description: 'Optional shell stdout to package.' },
    stderr: { type: 'string', description: 'Optional shell stderr to package.' },
  }, [], hints(true, false, false)),
  toolSpec('csm_runtime_status', 'Diagnostic status for the plugin runtime.', {
    sessionId: sessionTool,
    projectRoot: projectTool,
  }, [], hints(true, false, false)),
  toolSpec('csm_compaction_audit', 'Run a compaction telemetry audit.', {}, [], hints(true, false, false)),
];

export const EXTRA_MCP_TOOL_NAMES = EXTRA_MCP_TOOLS.map((tool) => tool.name);

function toolSpec(name: string, description: string, properties: Record<string, unknown>, required: string[] = [], annotations: ToolAnnotations = hints(true, false, false)) {
  return { name, title: name, description, annotations, inputSchema: { type: 'object', properties, required }, outputSchema: TOOL_OUTPUT_SCHEMA };
}

function hints(readOnlyHint: boolean, openWorldHint: boolean, destructiveHint: boolean): ToolAnnotations {
  return { readOnlyHint, openWorldHint, destructiveHint };
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint: boolean;
  destructiveHint: boolean;
}

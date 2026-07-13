export type AgentBookEventType =
  | 'session_start'
  | 'session_end'
  | 'file_read'
  | 'file_created'
  | 'file_modified'
  | 'file_deleted'
  | 'command_run'
  | 'command_result'
  | 'decision'
  | 'user_correction'
  | 'failed_approach'
  | 'test_run'
  | 'verification_evidence'
  | 'commit'
  | 'branch_change'
  | 'goal_set'
  | 'goal_achieved'
  | 'rule_activated'
  | 'rule_deactivated'
  | 'blocker_identified'
  | 'blocker_resolved'
  | 'csm_recall'
  | 'csm_injection'
  | 'milestone'
  | 'note';

export interface AgentBookEvent {
  eventId: string;
  projectId: string;
  sessionId: string | null;
  eventType: AgentBookEventType;
  timestamp: string;
  actor: string;
  summary: string;
  evidenceRefs: string[];
  files: string[];
  command: string | null;
  result: string | null;
  environment: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: 'active' | 'superseded' | 'resolved';
}

export interface AgentBookEventInput {
  projectId: string;
  sessionId?: string | null;
  eventType: AgentBookEventType;
  actor?: string;
  summary: string;
  evidenceRefs?: string[];
  files?: string[];
  command?: string | null;
  result?: string | null;
  environment?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: 'active' | 'superseded' | 'resolved';
}

export interface AgentBookSummary {
  summaryId: string;
  projectId: string;
  fromEventId: string;
  toEventId: string;
  eventCount: number;
  summary: string;
  openQuestions: string[];
  decisions: string[];
  failures: string[];
  nextSteps: string[];
  createdAt: string;
  model: string | null;
  sourceHash: string;
}

export interface AgentBookCurrentState {
  projectId: string;
  activeGoal: string | null;
  currentPhase: string | null;
  latestSummaryId: string | null;
  recentChanges: string[];
  blockers: string[];
  nextSteps: string[];
  rulesVersion: number;
  updatedAt: string;
  eventCount: number;
  sessionCount: number;
}

export interface AgentBookRule {
  ruleId: string;
  scope: 'project' | 'session' | 'global';
  priority: number;
  trigger: string | null;
  instruction: string;
  overridePolicy: 'override' | 'augment' | 'block';
  version: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentBookRuleInput {
  scope?: 'project' | 'session' | 'global';
  priority?: number;
  trigger?: string | null;
  instruction: string;
  overridePolicy?: 'override' | 'augment' | 'block';
  active?: boolean;
}

export interface AgentBookFrontPage {
  markdown: string;
  hash: string;
  eventCount: number;
  summaryId: string | null;
  rulesVersion: number;
  generatedAt: string;
}

export const AGENTBOOK_EVENT_TYPES: readonly AgentBookEventType[] = [
  'session_start', 'session_end', 'file_read', 'file_created', 'file_modified',
  'file_deleted', 'command_run', 'command_result', 'decision', 'user_correction',
  'failed_approach', 'test_run', 'verification_evidence', 'commit', 'branch_change',
  'goal_set', 'goal_achieved', 'rule_activated', 'rule_deactivated',
  'blocker_identified', 'blocker_resolved', 'csm_recall', 'csm_injection',
  'milestone', 'note',
] as const;

export const SUMMARY_THRESHOLD_EVENTS = 50;
export const SUMMARY_THRESHOLD_CHARS = 20_000;
export const AGENTBOOK_STATE_FILENAME = 'AGENTBOOK_STATE.md';

// ToolCallDistiller — Group tool calls by intent, extract structured summaries.
// Deterministic grouping (Section 16) before any LLM summarization.

import {
  DistillerConfig,
  ToolCallGroup,
  ToolCallRecord,
  ToolCallSummary,
} from './types.js';

const FILE_OP_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep']);
const BUILD_TOOLS = new Set(['bash']);
const SEARCH_TOOLS = new Set(['glob', 'grep']);
const DELEGATE_TOOLS = new Set(['task']);
const RESEARCH_TOOLS = new Set(['read', 'glob', 'grep', 'webfetch', 'websearch']);
const IMPLEMENT_TOOLS = new Set(['edit', 'write', 'multiedit']);

export class ToolCallDistiller {
  private buffer: ToolCallRecord[] = [];
  private groups: ToolCallGroup[] = [];
  private config: DistillerConfig;

  constructor(config: DistillerConfig) {
    this.config = config;
  }
  record(call: ToolCallRecord): void {
    this.buffer.push(call);
  }
  get bufferLength(): number {
    return this.buffer.length;
  }
  get currentGroups(): ToolCallGroup[] {
    return [...this.groups];
  }
  reset(): void {
    this.buffer = [];
    this.groups = [];
  }
  distill(): ToolCallSummary {
    const ungrouped = [...this.buffer];
    this.buffer = [];
    const grouped = this.groupByIntent(ungrouped);

    for (const group of grouped) {
      this.enrichGroup(group);
      this.mergeOrAdd(group);
    }
    return this.buildSummary();
  }
  private mergeOrAdd(group: ToolCallGroup): void {
    const existing = this.groups.find(
      (g) => g.intent === group.intent && g.outcome === 'unknown',
    );
    if (!existing) {
      this.groups.push(group);
      return;
    }
    existing.toolCalls.push(...group.toolCalls);
    existing.filesChanged.push(
      ...group.filesChanged.filter((f) => !existing.filesChanged.includes(f)),
    );
    existing.commandsRun.push(
      ...group.commandsRun.filter((c) => !existing.commandsRun.includes(c)),
    );
    existing.outcome = group.outcome;
    existing.errorSummary = group.errorSummary ?? existing.errorSummary;
    existing.fixApplied = group.fixApplied ?? existing.fixApplied;
    existing.proceduralInsight = group.proceduralInsight ?? existing.proceduralInsight;
    existing.timestamp = group.timestamp;
  }

  private groupByIntent(records: ToolCallRecord[]): ToolCallGroup[] {
    if (records.length < this.config.minCallsForGroup) return [];
    const groups: ToolCallGroup[] = [];
    let current = this.startGroup(records[0]);

    for (let i = 1; i < records.length; i++) {
      const call = records[i];
      const gapMs = call.timestamp - records[i - 1].timestamp;
      if (gapMs <= this.config.groupWindowMs && this.sameIntent(current.toolCalls, call)) {
        current.toolCalls.push(call);
        current.timestamp = call.timestamp;
      } else {
        groups.push(current);
        current = this.startGroup(call);
      }
    }
    groups.push(current);
    return groups.filter((g) => g.toolCalls.length >= this.config.minCallsForGroup);
  }

  private startGroup(first: ToolCallRecord): ToolCallGroup {
    return {
      id: `distill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      intent: '',
      toolCalls: [first],
      filesChanged: [],
      commandsRun: [],
      outcome: 'unknown',
      timestamp: first.timestamp,
    };
  }
  private sameIntent(calls: ToolCallRecord[], next: ToolCallRecord): boolean {
    const prevTool = calls[calls.length - 1].tool;
    if (FILE_OP_TOOLS.has(prevTool) && FILE_OP_TOOLS.has(next.tool)) return true;
    if (prevTool === next.tool) return true;
    if (BUILD_TOOLS.has(prevTool) && BUILD_TOOLS.has(next.tool)) return true;
    if (SEARCH_TOOLS.has(prevTool) && SEARCH_TOOLS.has(next.tool)) return true;

    const allTools = new Set([...calls.map(c => c.tool), next.tool]);
    const allResearchOrImpl = [...allTools].every(t => RESEARCH_TOOLS.has(t) || IMPLEMENT_TOOLS.has(t));
    if (allResearchOrImpl && allTools.size <= 3) return true;

    return false;
  }
  private enrichGroup(group: ToolCallGroup): void {
    group.intent = this.detectIntent(group);
    const { files, commands } = this.extractArtifacts(group);
    group.filesChanged = files;
    group.commandsRun = commands;
    group.outcome = this.detectOutcome(group);
    group.errorSummary = this.extractError(group);
    group.fixApplied = this.detectFix(group);
    group.proceduralInsight = this.extractInsight(group);
  }
  private detectIntent(group: ToolCallGroup): string {
    const tools = new Set(group.toolCalls.map((c) => c.tool));
    const firstTool = [...tools][0];
    if (tools.size === 1 && FILE_OP_TOOLS.has(firstTool)) {
      const file = group.toolCalls[0].filePath ?? 'files';
      const fileName = file.split(/[\\/]/).pop() ?? file;
      return `Edit ${fileName}`;
    }
    if (BUILD_TOOLS.has(firstTool)) {
      const cmd = group.toolCalls[0].args?.command as string | undefined;
      return cmd ? `Run: ${cmd.slice(0, 40)}` : 'Run command';
    }
    if ([...tools].every((t) => SEARCH_TOOLS.has(t))) return 'Search codebase';
    if (DELEGATE_TOOLS.has(firstTool)) return 'Delegate sub-task';

    const toolList = [...tools].sort().join('+');
    if ([...tools].every(t => RESEARCH_TOOLS.has(t))) return `Research (${toolList})`;
    if ([...tools].every(t => RESEARCH_TOOLS.has(t) || IMPLEMENT_TOOLS.has(t))) return `Research+Implement (${toolList})`;

    if (group.toolCalls.length === 1) return `Call ${firstTool}`;
    return `Multi-tool (${toolList})`;
  }
  private extractArtifacts(group: ToolCallGroup): { files: string[]; commands: string[] } {
    const files: string[] = [];
    const commands: string[] = [];
    for (const call of group.toolCalls) {
      const path = call.filePath ??
        (call.args?.filePath as string) ??
        (call.args?.path as string);
      if (path && typeof path === 'string' && !files.includes(path)) files.push(path);
      const cmd = call.args?.command as string | undefined;
      if (cmd && typeof cmd === 'string' && !commands.includes(cmd)) commands.push(cmd);
    }
    return { files, commands };
  }
  private detectOutcome(group: ToolCallGroup): 'success' | 'failure' | 'partial' | 'unknown' {
    const hasError = group.toolCalls.some(
      (c) => c.error || (c.exitCode !== undefined && c.exitCode !== 0),
    );
    const allErrors = group.toolCalls.every(
      (c) => c.error || (c.exitCode !== undefined && c.exitCode !== 0),
    );
    if (hasError && allErrors) return 'failure';
    if (hasError) return 'partial';
    if (group.toolCalls.length >= 2) return 'success';
    return 'unknown';
  }

  private extractError(group: ToolCallGroup): string | undefined {
    for (const call of group.toolCalls) {
      if (call.error) return call.error.slice(0, this.config.maxSummaryLength);
      const out = call.output?.toLowerCase() ?? '';
      if (out.includes('error') || out.includes('fail') || out.includes('exception')) {
        return call.output.slice(0, this.config.maxSummaryLength);
      }
    }
    return undefined;
  }

  private detectFix(group: ToolCallGroup): string | undefined {
    if (group.outcome !== 'success' && group.outcome !== 'partial') return undefined;
    const hasWrites = group.toolCalls.some((c) => c.tool === 'write' || c.tool === 'edit');
    if (!hasWrites || group.filesChanged.length === 0) return undefined;

    // Extract what was actually changed from edit args
    const edits = group.toolCalls.filter((c) => c.tool === 'edit' || c.tool === 'write');
    const changeDescriptions: string[] = [];

    for (const edit of edits) {
      const oldStr = edit.args?.oldString as string | undefined;
      const newStr = edit.args?.newString as string | undefined;
      const filePath = edit.filePath ?? (edit.args?.filePath as string | undefined);
      const fileName = filePath ? (filePath.split(/[\\/]/).pop() ?? filePath) : 'file';

      if (oldStr && newStr && oldStr !== newStr) {
        const removal = this.summarizeSnippet(oldStr, 80);
        const addition = this.summarizeSnippet(newStr, 80);
        changeDescriptions.push(`${fileName}: "${removal}" → "${addition}"`);
      } else if (filePath) {
        changeDescriptions.push(fileName);
      }
    }

    // Include error context if available (error → fix narrative)
    const error = this.extractError(group);
    if (error && changeDescriptions.length > 0) {
      const errorSnippet = this.summarizeSnippet(error, 80);
      return `Fixed "${errorSnippet}" by changing: ${changeDescriptions.join('; ')}`;
    }

    return changeDescriptions.length > 0
      ? `Changed: ${changeDescriptions.join('; ')}`
      : `Applied fix in ${group.filesChanged.join(', ')}`;
  }

  private summarizeSnippet(s: string, maxLen: number): string {
    const cleaned = s.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    return cleaned.slice(0, maxLen - 3) + '...';
  }

  private extractInsight(group: ToolCallGroup): string | undefined {
    if (group.outcome === 'failure' && group.errorSummary) {
      return `FAILED: ${group.intent} — ${this.summarizeSnippet(group.errorSummary, 100)}`;
    }
    if (group.outcome === 'partial') {
      return `PARTIAL: ${group.intent} — some steps succeeded, errors remain`;
    }
    if (group.outcome === 'success' && group.fixApplied) {
      return group.fixApplied;
    }
    if (group.outcome === 'success' && group.filesChanged.length > 0) {
      return `Completed: ${group.intent} — ${group.filesChanged.length} file(s) changed`;
    }
    return undefined;
  }

  private buildSummary(): ToolCallSummary {
    const top = this.groups.slice(-this.config.maxContextSummaries);
    const lines: string[] = ['=== TOOL CALL DISTILLATION ==='];
    for (const group of top) {
      const status = group.outcome === 'success' ? 'OK'
        : group.outcome === 'failure' ? 'FAIL'
        : group.outcome === 'partial' ? 'PARTIAL' : '?';
      lines.push(`${status} ${group.intent}`);
      if (group.filesChanged.length > 0) {
        lines.push(`  Files: ${group.filesChanged.map((f) => f.split(/[\\/]/).pop() ?? f).join(', ')}`);
      }
      if (group.errorSummary && group.outcome !== 'success') {
        lines.push(`  Error: ${group.errorSummary.slice(0, 80).replace(/\n/g, ' ')}`);
      }
      if (group.fixApplied) lines.push(`  Fix: ${group.fixApplied}`);
      if (group.proceduralInsight && group.outcome === 'success') {
        lines.push(`  → ${group.proceduralInsight}`);
      }
    }
    return {
      id: `summary_${Date.now()}`,
      sessionId: this.groups[0]?.toolCalls[0]?.sessionId ?? '',
      groups: [...this.groups],
      compressed: lines.slice(0, 50).join('\n'),
      totalCallsSummarized: top.reduce((sum, g) => sum + g.toolCalls.length, 0),
      builtAt: new Date(),
    };
  }
}

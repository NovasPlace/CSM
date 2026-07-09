import type { DatabasePool } from './types.js';
import { getLogger } from './logger.js';

export interface LessonTrigger {
  memoryId: number;
  content: string;
  toolPatterns: string[];
  filePatterns: string[];
  argPatterns: Record<string, string>;
  importance: number;
}

interface TriggerRule {
  toolPatterns: string[];
  filePatterns: string[];
  argPatterns: Record<string, string>;
}

const BUILTIN_PATTERNS: Record<string, TriggerRule> = {
  'powershell-replace-file': {
    toolPatterns: ['bash'],
    filePatterns: ['.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.sql', '.yml', '.yaml'],
    argPatterns: { command: '\\.Replace\\(' },
  },
  'powershell-set-content': {
    toolPatterns: ['bash'],
    filePatterns: ['.ts', '.js', '.tsx', '.jsx', '.json', '.md', '.sql', '.yml', '.yaml'],
    argPatterns: { command: 'Set-Content|Out-File' },
  },
  'check-hooks-api': {
    toolPatterns: ['bash', 'edit', 'write'],
    filePatterns: [],
    argPatterns: { command: "'tool\\.execute\\.after\\.", filePath: 'hooks/' },
  },
  'git-force-push': {
    toolPatterns: ['bash'],
    filePatterns: [],
    argPatterns: { command: 'push.*--force|push.*-f' },
  },
  'commit-secrets': {
    toolPatterns: ['bash', 'edit', 'write'],
    filePatterns: ['.env', 'credentials', 'secret', '.pem', '.key'],
    argPatterns: {},
  },
  'run-arbitrary-url': {
    toolPatterns: ['bash'],
    filePatterns: [],
    argPatterns: { command: 'curl.*\\|.*sh|wget.*\\|.*sh|irm.*\\|.*iex' },
  },
};

export class LessonTriggerCache {
  private triggers: LessonTrigger[] = [];
  private lastRefresh = 0;
  private readonly REFRESH_INTERVAL_MS = 60_000;

  constructor(
    private readonly pool: DatabasePool,
    private readonly refreshIntervalMs?: number,
  ) {}

  async refresh(): Promise<void> {
    const now = Date.now();
    const interval = this.refreshIntervalMs ?? this.REFRESH_INTERVAL_MS;
    if (now - this.lastRefresh < interval && this.triggers.length > 0) return;

    try {
      const result = await this.pool.query(
        `SELECT id, content, importance, tags, metadata
         FROM memories
         WHERE memory_type = 'lesson'
           AND importance >= 0.6
         ORDER BY importance DESC, created_at DESC
         LIMIT 50`,
      );

      this.triggers = (result.rows as unknown[]).map((row) =>
        this.rowToTrigger(row as Record<string, unknown>),
      );

      for (const [key, rule] of Object.entries(BUILTIN_PATTERNS)) {
        this.triggers.push({
          memoryId: -1,
          content: this.builtinLesson(key),
          toolPatterns: rule.toolPatterns,
          filePatterns: rule.filePatterns,
          argPatterns: rule.argPatterns,
          importance: 0.75,
        });
       }

       this.lastRefresh = now;
     } catch (error) {
       getLogger().error('LessonTriggers refresh failed', error instanceof Error ? error : undefined);
     }
  }

  matchTriggers(toolName: string, args: Record<string, unknown>): LessonTrigger[] {
    const matches: LessonTrigger[] = [];

    for (const trigger of this.triggers) {
      const toolMatch = trigger.toolPatterns.length === 0
        || trigger.toolPatterns.includes(toolName)
        || trigger.toolPatterns.some((p) => toolName.includes(p));

      if (!toolMatch) continue;

      let fileMatch = trigger.filePatterns.length === 0;
      if (!fileMatch) {
        const filePath = String(args?.filePath ?? args?.path ?? args?.pattern ?? '');
        fileMatch = trigger.filePatterns.some((p) => filePath.endsWith(p) || filePath.includes(p));
      }

      let argMatch = Object.keys(trigger.argPatterns).length === 0;
      if (!argMatch) {
        argMatch = Object.entries(trigger.argPatterns).every(([key, pattern]) => {
          const val = String(args?.[key] ?? '');
          try {
            return new RegExp(pattern, 'i').test(val);
          } catch {
            return val.toLowerCase().includes(pattern.toLowerCase());
          }
        });
      }

      if (toolMatch && fileMatch && argMatch) {
        matches.push(trigger);
      }
    }

    return matches;
  }

  buildInjection(toolName: string, args: Record<string, unknown>): string | null {
    const matches = this.matchTriggers(toolName, args);
    if (matches.length === 0) return null;

    const lines: string[] = ['<lesson_triggers>', ''];
    for (const trigger of matches) {
      const id = trigger.memoryId > 0 ? ` #${trigger.memoryId}` : '';
      lines.push(`- [LESSON${id}] ${trigger.content}`);
    }
    lines.push('');
    lines.push('</lesson_triggers>');

    return lines.join('\n');
  }

  buildFullSystemInjection(): string | null {
    if (this.triggers.length === 0) return null;

    const byTool = new Map<string, LessonTrigger[]>();
    for (const trigger of this.triggers) {
      const key = trigger.toolPatterns.length > 0
        ? trigger.toolPatterns.join('/')
        : '*';
      const list = byTool.get(key) ?? [];
      list.push(trigger);
      byTool.set(key, list);
    }

    const lines: string[] = [
      '<active_lessons>',
      '',
      'The following lessons are TRIGGERED by specific tool/arg patterns. Follow them when you use the matching tool.',
      '',
    ];

    for (const [toolKey, triggers] of byTool) {
      const label = toolKey === '*' ? 'any tool' : toolKey;
      lines.push(`### ${label}`);
      for (const trigger of triggers) {
        const id = trigger.memoryId > 0 ? ` #${trigger.memoryId}` : '';
        const when = trigger.filePatterns.length > 0
          ? ` (files: ${trigger.filePatterns.join(', ')})`
          : '';
        lines.push(`- [LESSON${id}]${when} ${trigger.content}`);
      }
      lines.push('');
    }

    lines.push('</active_lessons>');
    return lines.join('\n');
  }

   private rowToTrigger(row: Record<string, unknown>): LessonTrigger {
    const meta = (row.metadata as Record<string, unknown> | undefined) ?? {};
    const triggers = (meta.triggers as Record<string, unknown> | undefined) ?? (meta.triggerPatterns as Record<string, unknown> | undefined) ?? {};
    const toolPatterns: string[] = (triggers.tools as string[] | undefined) ?? this.inferToolPatterns(row.content as string, (row.tags as unknown[]).map((tag) => tag as string));
    const filePatterns: string[] = (triggers.files as string[] | undefined) ?? this.inferFilePatterns(row.content as string, (row.tags as unknown[]).map((tag) => tag as string));
    const argPatterns: Record<string, string> = (triggers.args as Record<string, string> | undefined) ?? {};

    return {
      memoryId: row.id as number,
      content: this.makeActionable(row.content as string),
      toolPatterns,
      filePatterns,
      argPatterns,
      importance: row.importance as number ?? 0.7,
    };
  }

  private inferToolPatterns(content: string, tags: string[] = []): string[] {
    const tools: string[] = [];
    for (const tag of tags) {
      if (tag.startsWith('tool:')) {
        tools.push(tag.slice(5));
      }
    }
    const lower = content.toLowerCase();
    if (lower.includes('powershell') || lower.includes('.replace(') || lower.includes('set-content')) tools.push('bash');
    if (lower.includes('edit tool') || lower.includes('file edit')) tools.push('edit');
    if (lower.includes('write tool') || lower.includes('file write')) tools.push('write');
    if (tools.length === 0) tools.push('bash', 'edit', 'write');
    return [...new Set(tools)];
  }

  private inferFilePatterns(content: string, tags: string[] = []): string[] {
    const exts: string[] = [];
    for (const tag of tags) {
      if (tag.startsWith('ext:') || tag.startsWith('file:')) {
        exts.push(tag.includes('.') ? tag.slice(tag.lastIndexOf('.')) : tag);
      }
    }
    return exts;
  }

  private makeActionable(content: string): string {
    const lower = content.toLowerCase();
    if (lower.startsWith('lesson:') || lower.startsWith('lessone:')) {
      content = content.replace(/^lessons?:\s*/i, '');
    }
    if (!lower.includes('use ') && !lower.includes('never ') && !lower.includes('always ') && !lower.includes('avoid ') && !lower.includes('do not ') && !lower.includes("don't ")) {
      content = `Avoid this — ${content}`;
    }
    return content;
  }

  private builtinLesson(key: string): string {
    switch (key) {
      case 'powershell-replace-file':
        return 'NEVER use PowerShell .Replace() on source files (.ts, .js, etc.) — \\r\\n line endings cause silent match failures. Use the Edit tool instead.';
      case 'powershell-set-content':
        return 'NEVER use Set-Content/Out-File on source files — they mangle encoding and line endings. Use the Write tool instead.';
      case 'check-hooks-api':
        return 'Before adding new hook names to a plugin, check the Hooks interface in the SDK — only registered hook names are valid. Merge into existing hooks instead.';
      case 'git-force-push':
        return 'Never force-push to shared branches. Use --force-with-lease if absolutely necessary.';
      case 'commit-secrets':
        return 'Never commit .env, credentials, .pem, or .key files. Add them to .gitignore first.';
      case 'run-arbitrary-url':
        return 'Never pipe curl/wget/irm output directly into sh/iex. Download first, inspect, then run.';
      default:
        return key;
    }
  }
}

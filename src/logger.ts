import { AsyncLocalStorage } from 'node:async_hooks';
import type { PluginContext } from './plugin-context.js';
import { redactSensitiveText } from './sensitive-redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerContext {
  sessionId?: string;
  projectId?: string;
  turnId?: string;
  memoryId?: string;
  toolName?: string;
  correlationId?: string;
  eventType?: 'context_governor';
  profile?: string;
  thresholds?: string;
  reason?: string;
  observedAt?: string;
  outcome?: string;
  layer?: string;
}

export interface LoggerOptions {
  sessionId?: string;
  projectId?: string;
  verbose?: boolean;
  json?: boolean;
}

export class Logger {
  private context: LoggerContext;
  private verbose: boolean;
  private isJson: boolean;

  constructor(options?: LoggerOptions) {
    this.context = {
      sessionId: options?.sessionId,
      projectId: options?.projectId,
    };
    this.verbose = options?.verbose ?? process.env.CSM_PROMPT_DEBUG === 'true';
    this.isJson = options?.json ?? process.env.CSM_PROMPT_DEBUG === 'true';
  }

  private formatMessage(level: LogLevel, message: string, context: LoggerContext = {}): string {
    const allContext = {
      ...this.context,
      ...LOG_CONTEXT.getStore(),
      ...context,
      timestamp: new Date().toISOString(),
      level,
    };

    if (this.isJson) {
      return JSON.stringify({
        ...redactContext(allContext),
        message: redactSensitiveText(message),
      });
    }

    const parts: string[] = [`[${level.toUpperCase()}]`];

    if (allContext.sessionId) {
      parts.push(`session:${allContext.sessionId}`);
    }

    if (allContext.projectId) {
      parts.push(`project:${allContext.projectId}`);
    }

    if (allContext.turnId) {
      parts.push(`turn:${allContext.turnId}`);
    }

    if (allContext.memoryId) {
      parts.push(`memory:${allContext.memoryId}`);
    }

    if (allContext.toolName) {
      parts.push(`tool:${allContext.toolName}`);
    }

    if (allContext.correlationId) {
      parts.push(`correlation:${allContext.correlationId}`);
    }

    appendAuditContext(parts, allContext);

    parts.push(redactSensitiveText(message));
    return parts.join(' ');
  }

  debug(message: string, context?: LoggerContext): void {
    if (this.verbose) {
      console.error(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LoggerContext): void {
    console.error(this.formatMessage('info', message, context));
  }

  warn(message: string, context?: LoggerContext): void {
    console.warn(this.formatMessage('warn', message, context));
  }

  error(message: string, error?: Error, context?: LoggerContext): void {
    const errorContext = error
      ? {
        ...context,
        error: redactSensitiveText(error.message),
        stack: error.stack ? redactSensitiveText(error.stack) : undefined,
      }
      : context;

    if (this.isJson) {
      console.error(this.formatMessage('error', message, errorContext));
    } else {
      const parts: string[] = [this.formatMessage('error', message, errorContext)];

      if (error) {
        if (error.stack) {
          parts.push(redactSensitiveText(error.stack));
        } else {
          parts.push(redactSensitiveText(error.message));
        }
      }

      console.error(parts.join('\n'));
    }
  }

  setSession(sessionId: string, projectId?: string): void {
    this.context.sessionId = sessionId;
    this.context.projectId = projectId;
  }

  setTurn(turnId: string): void {
    this.context.turnId = turnId;
  }

  setMemory(memoryId: string): void {
    this.context.memoryId = memoryId;
  }

  setTool(toolName: string): void {
    this.context.toolName = toolName;
  }

  clearContext(): void {
    const { sessionId, projectId } = this.context;
    this.context = { sessionId, projectId };
  }
}

const LOG_CONTEXT = new AsyncLocalStorage<LoggerContext>();

export function withLogContext<T>(context: LoggerContext, task: () => T): T {
  const inherited = LOG_CONTEXT.getStore() ?? {};
  const defined = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as LoggerContext;
  return LOG_CONTEXT.run({ ...inherited, ...defined }, task);
}

function redactContext<T extends LoggerContext & { timestamp: string; level: LogLevel }>(
  context: T,
): T {
  const safe = { ...context };
  for (const key of Object.keys(safe) as Array<keyof T>) {
    if (typeof safe[key] === 'string') safe[key] = redactSensitiveText(safe[key] as string) as T[keyof T];
  }
  return safe;
}

function appendAuditContext(parts: string[], context: LoggerContext): void {
  if (!context.eventType) return;
  parts.push(`event:${context.eventType}`);
  if (context.profile) parts.push(`profile:${context.profile}`);
  if (context.outcome) parts.push(`outcome:${context.outcome}`);
  if (context.observedAt) parts.push(`observed_at:${context.observedAt}`);
}

let globalLogger: Logger | null = null;

export function getLogger(options?: LoggerOptions): Logger {
  if (!globalLogger) {
    globalLogger = new Logger(options);
  }
  return globalLogger;
}

export function createLoggerWithContext(pluginCtx: PluginContext): Logger {
  const logger = new Logger({
    sessionId: pluginCtx.state?.currentSessionId?.toString(),
    projectId: pluginCtx.directory,
    verbose: pluginCtx.config?.promptDebug,
  });

  return logger;
}

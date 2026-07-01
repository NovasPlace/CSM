import type { PluginContext } from './plugin-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerContext {
  sessionId?: string;
  projectId?: string;
  turnId?: string;
  memoryId?: string;
  toolName?: string;
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
      ...context,
      timestamp: new Date().toISOString(),
      level,
    };

    if (this.isJson) {
      return JSON.stringify({
        ...allContext,
        message,
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

    parts.push(message);
    return parts.join(' ');
  }

  debug(message: string, context?: LoggerContext): void {
    if (this.verbose) {
      console.log(this.formatMessage('debug', message, context));
    }
  }

  info(message: string, context?: LoggerContext): void {
    console.log(this.formatMessage('info', message, context));
  }

  warn(message: string, context?: LoggerContext): void {
    console.warn(this.formatMessage('warn', message, context));
  }

  error(message: string, error?: Error, context?: LoggerContext): void {
    const errorContext = error
      ? { ...context, error: error.message, stack: error.stack }
      : context;

    if (this.isJson) {
      console.error(JSON.stringify({
        ...errorContext,
        message,
        level: 'error',
        timestamp: new Date().toISOString(),
      }));
    } else {
      const parts: string[] = [this.formatMessage('error', message, errorContext)];

      if (error) {
        if (error.stack) {
          parts.push(error.stack);
        } else {
          parts.push(error.message);
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
    this.context = {};
    const _sessionId = this.context.sessionId; // preserve session
    const _projectId = this.context.projectId; // preserve project
  }
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

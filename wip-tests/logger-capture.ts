import type { Logger } from '../src/logger.js';
import { runWithLogger } from '../src/logger.js';

export type ErrorLog = [message: string, error?: Error, context?: unknown];

export async function captureErrorLogs<T>(task: () => Promise<T>): Promise<{
  result: T;
  errors: ErrorLog[];
}> {
  const errors: ErrorLog[] = [];
  const logger = {
    error(message: string, error?: Error, context?: unknown) {
      errors.push([message, error, context]);
    },
    debug() {}, info() {}, warn() {},
  } as unknown as Logger;
  const result = await runWithLogger(logger, task);
  return { result, errors };
}

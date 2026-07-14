import { createHash } from 'node:crypto';
import type { BuiltContextInjection } from './context-injection-contract.js';
import type { ContextInjectionLogger } from './context-injection-logger.js';

export function logRuntimeInjection(
  logger: ContextInjectionLogger | undefined,
  built: BuiltContextInjection,
  projectId: string | null,
  sessionId: string,
): Promise<void> {
  if (!logger) return Promise.resolve();
  const blockHash = createHash('sha256').update(built.text).digest('hex');
  return logger.logInjection({
    idempotencyKey: `${built.injectionKind}:${sessionId}:${blockHash}`,
    projectId,
    sessionId,
    injectionKind: built.injectionKind,
    sourceTurnId: null,
    built,
    blockHash,
    status: 'injected',
  });
}

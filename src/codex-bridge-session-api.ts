import { createHash } from 'node:crypto';
import type { BridgeDeps } from './bridge-ops.js';

export class CodexBridgeSessionApi {
  constructor(private readonly deps: BridgeDeps) {}

  async ensure(projectRoot?: string, sessionId?: string): Promise<string | undefined> {
    if (!projectRoot && !sessionId) return undefined;
    const resolvedProject = projectRoot ?? 'codex-bridge';
    const resolvedSession = sessionId ?? defaultSessionId(resolvedProject);
    await this.deps.memoryManager.createSession(resolvedSession, resolvedProject);
    this.deps.contextRecall.setSession(resolvedSession, resolvedProject);
    await this.deps.memoryManager.upsertProjectScope(
      resolvedProject, resolvedProject, resolvedProject,
    );
    return resolvedSession;
  }
}

function defaultSessionId(projectRoot: string): string {
  const hash = createHash('sha1').update(projectRoot).digest('hex').slice(0, 12);
  return `codex-${hash}`;
}

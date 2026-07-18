import { createHash } from 'node:crypto';
import type { BridgeDeps } from './bridge-ops.js';

export class CodexBridgeSessionApi {
  constructor(private readonly deps: BridgeDeps) {}

  async ensure(projectRoot?: string, sessionId?: string): Promise<string | undefined> {
    if (!projectRoot && !sessionId) return undefined;
    const existing = sessionId
      ? await this.deps.memoryManager.getSession(sessionId)
      : null;
    if (existing?.projectId && projectRoot && existing.projectId !== projectRoot) {
      throw new Error(
        `Session ${sessionId} belongs to a different project; refusing to reassign its data boundary.`,
      );
    }
    const resolvedProject = projectRoot ?? existing?.projectId ?? 'codex-bridge';
    const resolvedSession = sessionId ?? defaultSessionId(resolvedProject);
    if (!existing) {
      await this.deps.memoryManager.createSession(resolvedSession, resolvedProject);
    }
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

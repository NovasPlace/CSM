import type { PluginInput, ToolDefinition } from '@opencode-ai/plugin';
import { resolve } from 'node:path';
import { defaultConfigForDirectory, validatePluginConfig } from './config.js';
import { disposeAll } from './hooks/dispose-hooks.js';
import { registerTools } from './hooks/tool-hooks.js';
import { Logger } from './logger.js';
import type { PluginContext } from './plugin-context.js';
import { startPluginContext } from './plugin-runtime-start.js';
import { mergePluginConfig, normalizeProviderRuntimeConfig } from './provider-runtime-config.js';
import { CodexTranscriptClient } from './codex-transcript-client.js';
import { CODEX_HOST_PROFILE, type HostProfile } from './native-host-profile.js';

export interface CodexNativeInvocation {
  projectRoot: string;
  sessionId?: string;
  transcriptPath?: string;
  args: Record<string, unknown>;
}

export class CodexNativeRuntime {
  private readonly transcript: CodexTranscriptClient;
  private readonly input: PluginInput;
  private disposed = false;

  private constructor(
    readonly projectRoot: string,
    readonly context: PluginContext,
    input: PluginInput,
    transcript: CodexTranscriptClient,
    readonly profile: HostProfile,
  ) {
    this.input = input;
    this.transcript = transcript;
  }

  static async connect(
    projectRoot: string,
    profile: HostProfile = CODEX_HOST_PROFILE,
  ): Promise<CodexNativeRuntime> {
    const root = resolve(projectRoot);
    const transcript = new CodexTranscriptClient();
    const input = pluginInput(root, transcript);
    const configured = mergePluginConfig(defaultConfigForDirectory(root), {});
    const config = normalizeProviderRuntimeConfig(validatePluginConfig(configured));
    const context = await startPluginContext(
      input,
      config,
      new Logger({ projectId: root, verbose: config.promptDebug }),
    );
    return new CodexNativeRuntime(root, context, input, transcript, profile);
  }

  setTranscriptPath(sessionId: string, transcriptPath: string | undefined): void {
    this.transcript.setTranscriptPath(sessionId, transcriptPath);
  }

  transcriptMessages(sessionId: string) {
    return this.transcript.messages(sessionId);
  }

  tools(): Record<string, ToolDefinition> {
    return registerTools(this.context) as Record<string, ToolDefinition>;
  }

  async execute(name: string, invocation: CodexNativeInvocation): Promise<Record<string, unknown>> {
    if (this.disposed) throw new Error('CSM native runtime is disposed.');
    const definition = this.tools()[name];
    if (!definition) throw new Error(`CSM tool ${name} is unavailable for the configured database provider.`);
    const sessionId = invocation.sessionId ?? this.context.state.currentSessionId ?? this.profile.defaultSessionId;
    this.setTranscriptPath(sessionId, invocation.transcriptPath);
    this.context.syncActiveSession(sessionId);
    const args = { ...invocation.args };
    delete args.projectRoot;
    delete args.sessionId;
    delete args.transcriptPath;
    let metadata: Record<string, unknown> = {};
    const result = await definition.execute(args, {
      sessionID: sessionId,
      messageID: `${this.profile.hostName}-${Date.now()}`,
      agent: this.profile.hostName,
      directory: this.projectRoot,
      worktree: this.projectRoot,
      abort: new AbortController().signal,
      metadata: (input) => { metadata = { ...metadata, ...input.metadata }; },
      ask: async () => undefined,
    });
    if (typeof result === 'string') return { output: result, metadata };
    return { ...result, metadata: { ...metadata, ...result.metadata } };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await disposeAll(this.input, this.context);
  }
}

export class CodexNativeRuntimeManager {
  private readonly runtimes = new Map<string, Promise<CodexNativeRuntime>>();

  constructor(readonly profile: HostProfile = CODEX_HOST_PROFILE) {}

  get(projectRoot: string): Promise<CodexNativeRuntime> {
    const root = resolve(projectRoot);
    let runtime = this.runtimes.get(root);
    if (!runtime) {
      runtime = CodexNativeRuntime.connect(root, this.profile);
      this.runtimes.set(root, runtime);
      runtime.catch(() => this.runtimes.delete(root));
    }
    return runtime;
  }

  async execute(name: string, invocation: CodexNativeInvocation): Promise<Record<string, unknown>> {
    return (await this.get(invocation.projectRoot)).execute(name, invocation);
  }

  async dispose(): Promise<void> {
    const runtimes = await Promise.allSettled(this.runtimes.values());
    await Promise.allSettled(runtimes.flatMap((result) => (
      result.status === 'fulfilled' ? [result.value.dispose()] : []
    )));
    this.runtimes.clear();
  }
}

function pluginInput(root: string, transcript: CodexTranscriptClient): PluginInput {
  return {
    client: transcript.client,
    project: { id: root, worktree: root, vcs: 'git', time: { created: Date.now(), updated: Date.now() } },
    directory: root,
    worktree: root,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL('http://127.0.0.1/'),
    $: (() => undefined),
  } as unknown as PluginInput;
}

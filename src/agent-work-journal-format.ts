const FILE_ARG_KEYS = ['filePath', 'path', 'pattern', 'command', 'url', 'query'];

export function inferToolIntent(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case 'read': return `Read ${args.filePath ?? args.path ?? 'file'}`;
    case 'write': return `Write ${args.filePath ?? args.path ?? 'file'}`;
    case 'edit': return `Edit ${args.filePath ?? args.path ?? 'file'}`;
    case 'grep': return `Search for "${args.pattern ?? '?'}" in ${args.include ?? 'files'}`;
    case 'glob': return `Find files matching "${args.pattern ?? '?'}"`;
    case 'bash': return `Run: ${String(args.command ?? '?').substring(0, 120)}`;
    case 'task': return `Launch subagent: ${String(args.description ?? args.prompt ?? '?').substring(0, 80)}`;
    case 'csm_memory_save': return `Save memory: ${String(args.content ?? '?').substring(0, 80)}`;
    case 'csm_memory_search': return `Search memories: "${args.query ?? '?'}"`;
    case 'csm_memory_lesson': return `Save lesson: ${String(args.content ?? '?').substring(0, 80)}`;
    case 'create_checkpoint': return 'Create checkpoint';
    default: return `${toolName}: ${safeArgsPreview(args)}`;
  }
}

export function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.substring(0, max)}...` : value;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function safeArgsPreview(args: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(args, (_key, value: unknown) => {
      if (typeof value === 'bigint') return value.toString();
      if (typeof value !== 'object' || value === null) return value;
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
      return value;
    });
    return (text ?? '{}').substring(0, 100);
  } catch {
    return '[Unserializable arguments]';
  }
}

export function extractTarget(
  toolName: string,
  args: Record<string, unknown>,
): string | undefined {
  if (toolName === 'bash' && typeof args.command === 'string') {
    return args.command.substring(0, 200);
  }
  for (const key of FILE_ARG_KEYS) {
    if (typeof args[key] === 'string') return args[key];
  }
  return undefined;
}

export function extractFilesTouched(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (['read', 'write', 'edit'].includes(toolName)) {
    const filePath = args.filePath ?? args.path;
    return typeof filePath === 'string' ? [filePath] : [];
  }
  if (toolName === 'glob' || toolName === 'grep') {
    const pattern = args.pattern ?? args.include;
    return typeof pattern === 'string' ? [`search:${pattern}`] : [];
  }
  return [];
}

export function summarizeResult(
  output: string,
  error?: string,
  exitCode?: number,
): string | undefined {
  if (error) return `Error: ${error.substring(0, 150)}`;
  if (exitCode !== undefined && exitCode !== 0) {
    return `Exit code ${exitCode}: ${output.substring(0, 100)}`;
  }
  if (!output) return undefined;
  if (output.length <= 150) return output;
  const firstLine = output.split('\n')[0] ?? '';
  return firstLine.length <= 150 ? firstLine : `${output.substring(0, 150)}...`;
}

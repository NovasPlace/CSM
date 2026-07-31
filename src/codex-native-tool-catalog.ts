import type { ToolDefinition } from '@opencode-ai/plugin';
import { z } from 'zod';
import type { PluginContext } from './plugin-context.js';
import { createRegisteredToolList } from './hooks/tool-registry.js';
import { VcmManager } from './vcm-manager.js';

export interface CodexNativeToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    openWorldHint: boolean;
    destructiveHint: boolean;
  };
}

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true } as const;

/**
 * Build Codex MCP schemas from CSM's canonical OpenCode registry.
 * The proxy is only used while the tool factories describe themselves; no
 * database or filesystem operation occurs until a real runtime executes one.
 */
export function createCodexNativeToolCatalog(): CodexNativeToolSpec[] {
  const registry = createRegisteredToolList(catalogContext());
  return Object.entries(registry).map(([name, value]) => toSpec(name, value));
}

export const CODEX_NATIVE_TOOL_NAMES = createCodexNativeToolCatalog().map(
  (tool) => tool.name,
);

export function isCodexNativeTool(name: string): boolean {
  return CODEX_NATIVE_TOOL_NAMES.includes(name);
}

function toSpec(name: string, value: unknown): CodexNativeToolSpec {
  const definition = value as ToolDefinition & {
    parameters?: Record<string, unknown>;
  };
  const inputSchema = definition.args
    ? z.toJSONSchema(z.object(definition.args), { unrepresentable: 'any' }) as Record<string, unknown>
    : { ...definition.parameters };
  const properties = {
    ...objectRecord(inputSchema.properties),
    projectRoot: {
      type: 'string',
      description: 'Absolute project/worktree root used to select the CSM runtime.',
    },
    sessionId: {
      type: 'string',
      description: 'Optional Codex session id. Native hooks supply this automatically when available.',
    },
  };
  const required = new Set(stringList(inputSchema.required));
  required.add('projectRoot');
  return {
    name,
    title: name,
    description: definition.description,
    inputSchema: {
      ...inputSchema,
      properties,
      required: [...required],
      additionalProperties: false,
    },
    outputSchema: OUTPUT_SCHEMA,
    annotations: toolAnnotations(name),
  };
}

function catalogContext(): PluginContext {
  const service = deepServiceProxy();
  const state = {
    currentSessionId: null,
    messageCount: 0,
    capturedMessageSizes: new Map(),
    recentUserMessages: new Map(),
    reentryInjected: new Set(),
    onboardingInjected: new Set(),
  };
  const database = Object.assign(Object.create(service), {
    getPool: () => service,
  });
  const explicit: Record<string, unknown> = {
    directory: 'C:\\csm-catalog',
    worktree: 'C:\\csm-catalog',
    state,
    config: service,
    database,
    vcmManager: new VcmManager(service as never, database as never),
    workLedger: service,
    reEntryProtocol: service,
  };
  return new Proxy(explicit, {
    get(target, property) {
      if (property in target) return target[String(property)];
      return service;
    },
  }) as unknown as PluginContext;
}

function deepServiceProxy(): never {
  const holder: { current?: unknown } = {};
  const callable = () => holder.current;
  const proxy: () => unknown = new Proxy(callable, {
    get(_target, property) {
      if (property === 'then') return undefined;
      if (property === Symbol.toPrimitive) return () => 'csm-catalog';
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy as object,
  });
  holder.current = proxy;
  return proxy as never;
}

function toolAnnotations(name: string): CodexNativeToolSpec['annotations'] {
  const destructive = /delete|merge|archive|promote|cleanup|deactivate|reject/.test(name);
  const readOnly = /search|list|report|status|preview|view|related|context|fetch|audit|state|model|knowledge|events/.test(name)
    && !destructive;
  return { readOnlyHint: readOnly, openWorldHint: false, destructiveHint: destructive };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
}

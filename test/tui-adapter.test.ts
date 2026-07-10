import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

async function loadMod() {
  const m = await import("../dist/tui.js");
  return m.default;
}

const pendingDisposes: Array<() => void> = [];
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const activeIntervals = new Set<ReturnType<typeof setInterval>>();
globalThis.setInterval = (((handler: any, timeout?: number, ...args: any[]) => {
  const timer = realSetInterval(handler, timeout, ...args); activeIntervals.add(timer); return timer;
}) as typeof setInterval);
globalThis.clearInterval = (((timer?: any) => {
  if (timer) activeIntervals.delete(timer); return realClearInterval(timer);
}) as typeof clearInterval);

function createLifecycle(onRegister?: () => void) {
  return { onDispose: (fn: Function) => { onRegister?.(); pendingDisposes.push(() => fn()); } };
}

function createApi(overrides: Record<string, unknown> = {}) {
  return {
    kv: {
      get: (_key: string, fallback: unknown) => fallback,
      set: () => {},
    },
    slots: { register: () => "id" },
    route: { register: () => () => {}, navigate: () => {} },
    command: { register: () => {} },
    lifecycle: createLifecycle(),
    theme: { current: {} },
    ...overrides,
  };
}

afterEach(() => {
  while (pendingDisposes.length > 0) pendingDisposes.pop()?.();
  for (const timer of activeIntervals) realClearInterval(timer);
  activeIntervals.clear();
});

describe("tui adapter", () => {
  it("exports a valid TuiPluginModule with tui function and no server", async () => {
    const mod = await loadMod();
    assert.ok(mod, "module exists");
    assert.equal(typeof mod.tui, "function", "tui is a function");
    assert.equal(mod.server, undefined, "server is undefined (TuiPluginModule)");
  });

  it("tui function does not throw on init with minimal mock api", async () => {
    const mod = await loadMod();
    let slotRegistered = false;
    let routeRegistered = false;
    const mockApi = createApi({
      slots: {
        register: (plugin: Record<string, unknown>) => {
          slotRegistered = true;
          assert.ok(plugin.sidebar_content, "has sidebar_content slot");
          assert.ok(plugin.sidebar_footer, "has sidebar_footer slot");
          assert.equal(typeof plugin.sidebar_content, "function", "sidebar_content is function");
          assert.equal(typeof plugin.sidebar_footer, "function", "sidebar_footer is function");
          return "mock-slot-id";
        },
      },
      route: { register: () => { routeRegistered = true; return () => {}; }, navigate: () => {} },
      theme: { current: { accent: "#fff", muted: "#888" } },
    });

    await mod.tui(mockApi as any, undefined, { version: "test" } as any);
    assert.ok(slotRegistered, "slots.register was called");
    assert.ok(routeRegistered, "route.register was called");
  });

  it("tui function gracefully handles slot.register failure", async () => {
    const mod = await loadMod();
    const failingApi = createApi({
      kv: { get: () => null, set: () => {} },
      slots: {
        register: () => { throw new Error("slots unavailable"); },
      },
      route: { register: () => { throw new Error("route unavailable"); }, navigate: () => {} },
    });

    await assert.doesNotReject(
      () => mod.tui(failingApi as any, undefined, {} as any),
      "TUI init must not throw even when registration fails"
    );
  });

  it("tui function gracefully handles route.register failure", async () => {
    const mod = await loadMod();
    const failingApi = createApi({
      kv: { get: () => null, set: () => {} },
      slots: { register: () => "ok" },
      route: { register: () => { throw new Error("route unavailable"); }, navigate: () => {} },
    });

    await assert.doesNotReject(
      () => mod.tui(failingApi as any, undefined, {} as any),
      "TUI init must not throw even when route registration fails"
    );
  });

  it("sidebar_content render returns null when kv has no data", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};
    const mockApi = createApi({
      slots: { register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; } },
    });

    await mod.tui(mockApi as any, undefined, {} as any);

    const result = capturedSlots.sidebar_content!({ session_id: "test" });
    assert.equal(result, null, "returns null when no data");
  });

  it("sidebar_footer render returns null when kv has no data", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};
    const mockApi = createApi({
      slots: { register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; } },
    });

    await mod.tui(mockApi as any, undefined, {} as any);

    const result = capturedSlots.sidebar_footer!({ session_id: "test" });
    assert.equal(result, null, "returns null when no data");
  });

  it("sidebar_content render handles populated stats safely", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};
    const mockApi = createApi({
      kv: {
        get: (key: string) => {
          if (key === "__csm_stats") return { totalMemories: 5, recentSessions: 1, lastCheckpoint: null, contextPressure: 10, compactions: 0 };
          return null;
        },
        set: () => {},
      },
      slots: { register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; } },
    });

    await mod.tui(mockApi as any, undefined, {} as any);
    const result = capturedSlots.sidebar_content!({ session_id: "test" });
    assert.notEqual(result, undefined, "returns a defined render result when stats exist");
  });

  it("readStats accepts populated kv data without throwing", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};
    const mockApi = createApi({
      kv: {
        get: (key: string) => {
          if (key === "__csm_stats") return { totalMemories: 42, recentSessions: 3, lastCheckpoint: "2025-01-15T10:00:00Z", contextPressure: 65, compactions: 7 };
          return null;
        },
        set: () => {},
      },
      slots: { register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; } },
    });

    await mod.tui(mockApi as any, undefined, {} as any);
    const result = capturedSlots.sidebar_content!({ session_id: "test" });
    assert.notEqual(result, undefined, "parses stored stats without throwing");
  });

  it("command registration does not throw", async () => {
    const mod = await loadMod();
    let commandRegistered = false;
    const mockApi = createApi({
      kv: { get: () => null, set: () => {} },
      command: {
        register: (fn: Function) => {
          commandRegistered = true;
          const items = fn();
          assert.ok(Array.isArray(items), "command returns array");
          assert.equal(items[0].title, "Memory Dashboard");
          return () => {};
        },
      },
    });

    await mod.tui(mockApi as any, undefined, {} as any);
    assert.ok(commandRegistered, "command.register was called");
  });

  it("lifecycle.onDispose is registered", async () => {
    const mod = await loadMod();
    let disposeRegistered = false;
    const mockApi = createApi({
      kv: { get: () => null, set: () => {} },
      lifecycle: createLifecycle(() => { disposeRegistered = true; }),
    });

    await mod.tui(mockApi as any, undefined, {} as any);
    assert.ok(disposeRegistered, "lifecycle.onDispose was called");
  });

  it("all registrations succeed with full mock api", async () => {
    const mod = await loadMod();
    const calls: string[] = [];
    const fullApi = createApi({
      kv: {
        get: (key: string, fallback: unknown) => {
          if (key === "__csm_stats") return { totalMemories: 10, recentSessions: 2, lastCheckpoint: null, contextPressure: 30, compactions: 1 };
          return fallback;
        },
        set: () => {},
      },
      slots: { register: () => { calls.push("slots"); return "id"; } },
      route: { register: () => { calls.push("route"); return () => {}; }, navigate: () => {} },
      command: { register: () => { calls.push("command"); return () => {}; } },
      lifecycle: createLifecycle(() => { calls.push("lifecycle"); }),
    });

    await mod.tui(fullApi as any, undefined, {} as any);
    assert.ok(calls.includes("slots"), "slots registered");
    assert.ok(calls.includes("route"), "route registered");
    assert.ok(calls.includes("command"), "command registered");
    assert.ok(calls.includes("lifecycle"), "lifecycle registered");
  });

  it("does not poll PostgreSQL when configured for SQLite", async () => {
    const previous = process.env.CSM_DATABASE_PROVIDER;
    process.env.CSM_DATABASE_PROVIDER = "sqlite";
    let written: Record<string, unknown> | null = null;
    try {
      const imported = await import(`../dist/tui.js?sqlite-${Date.now()}`);
      const mockApi = createApi({
        kv: {
          get: (_key: string, fallback: unknown) => fallback,
          set: (_key: string, value: Record<string, unknown>) => { written = value; },
        },
      });
      await imported.default.tui(mockApi as any, undefined, {} as any);
      assert.match(String(written?.providerStatus), /SQLite core-memory mode/);
    } finally {
      if (previous === undefined) delete process.env.CSM_DATABASE_PROVIDER;
      else process.env.CSM_DATABASE_PROVIDER = previous;
    }
  });
});

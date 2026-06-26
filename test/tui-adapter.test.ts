import { describe, it } from "node:test";
import assert from "node:assert/strict";

async function loadMod() {
  const m = await import("../dist/tui.js");
  return m.default;
}

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

    const mockApi = {
      kv: {
        get: (_key: string, fallback: unknown) => fallback,
        set: () => {},
      },
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
      route: {
        register: () => { routeRegistered = true; return () => {}; },
        navigate: () => {},
      },
      command: {
        register: () => {},
      },
      lifecycle: {
        onDispose: () => {},
      },
      theme: {
        current: { accent: "#fff", muted: "#888" },
      },
    };

    await mod.tui(mockApi as any, undefined, { version: "test" } as any);
    assert.ok(slotRegistered, "slots.register was called");
    assert.ok(routeRegistered, "route.register was called");
  });

  it("tui function gracefully handles slot.register failure", async () => {
    const mod = await loadMod();

    const failingApi = {
      kv: { get: () => null, set: () => {} },
      slots: {
        register: () => { throw new Error("slots unavailable"); },
      },
      route: { register: () => { throw new Error("route unavailable"); }, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await assert.doesNotReject(
      () => mod.tui(failingApi as any, undefined, {} as any),
      "TUI init must not throw even when registration fails"
    );
  });

  it("tui function gracefully handles route.register failure", async () => {
    const mod = await loadMod();

    const failingApi = {
      kv: { get: () => null, set: () => {} },
      slots: {
        register: () => "ok",
      },
      route: { register: () => { throw new Error("route unavailable"); }, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await assert.doesNotReject(
      () => mod.tui(failingApi as any, undefined, {} as any),
      "TUI init must not throw even when route registration fails"
    );
  });

  it("sidebar_content render returns null when kv has no data", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};

    const mockApi = {
      kv: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
      slots: {
        register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; },
      },
      route: { register: () => () => {}, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await mod.tui(mockApi as any, undefined, {} as any);

    const result = capturedSlots.sidebar_content!({ session_id: "test" });
    assert.equal(result, null, "returns null when no data");
  });

  it("sidebar_footer render returns null when kv has no data", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};

    const mockApi = {
      kv: { get: (_key: string, fallback: unknown) => fallback, set: () => {} },
      slots: {
        register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; },
      },
      route: { register: () => () => {}, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await mod.tui(mockApi as any, undefined, {} as any);

    const result = capturedSlots.sidebar_footer!({ session_id: "test" });
    assert.equal(result, null, "returns null when no data");
  });

  it("sidebar_content render returns null when h() is unavailable (no solid-js)", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};

    const mockApi = {
      kv: {
        get: (key: string) => {
          if (key === "__csm_stats") return { totalMemories: 5, recentSessions: 1, lastCheckpoint: null, contextPressure: 10, compactions: 0 };
          return null;
        },
        set: () => {},
      },
      slots: {
        register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; },
      },
      route: { register: () => () => {}, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await mod.tui(mockApi as any, undefined, {} as any);

    const result = capturedSlots.sidebar_content!({ session_id: "test" });
    assert.equal(result, null, "returns null when solid-js h() is not available in test env");
  });

  it("readStats parses kv data safely", async () => {
    const mod = await loadMod();
    let capturedSlots: Record<string, Function> = {};

    const mockApi = {
      kv: {
        get: (key: string) => {
          if (key === "__csm_stats") return { totalMemories: 42, recentSessions: 3, lastCheckpoint: "2025-01-15T10:00:00Z", contextPressure: 65, compactions: 7 };
          return null;
        },
        set: () => {},
      },
      slots: {
        register: (plugin: Record<string, Function>) => { capturedSlots = plugin; return "id"; },
      },
      route: { register: () => () => {}, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await mod.tui(mockApi as any, undefined, {} as any);

    const result = capturedSlots.sidebar_content!({ session_id: "test" });
    assert.equal(result, null, "returns null because h() is not available, but does not throw");
  });

  it("command registration does not throw", async () => {
    const mod = await loadMod();
    let commandRegistered = false;

    const mockApi = {
      kv: { get: () => null, set: () => {} },
      slots: { register: () => "id" },
      route: { register: () => () => {}, navigate: () => {} },
      command: {
        register: (fn: Function) => {
          commandRegistered = true;
          const items = fn();
          assert.ok(Array.isArray(items), "command returns array");
          assert.equal(items[0].title, "Memory Dashboard");
          return () => {};
        },
      },
      lifecycle: { onDispose: () => {} },
      theme: { current: {} },
    };

    await mod.tui(mockApi as any, undefined, {} as any);
    assert.ok(commandRegistered, "command.register was called");
  });

  it("lifecycle.onDispose is registered", async () => {
    const mod = await loadMod();
    let disposeRegistered = false;

    const mockApi = {
      kv: { get: () => null, set: () => {} },
      slots: { register: () => "id" },
      route: { register: () => () => {}, navigate: () => {} },
      command: { register: () => {} },
      lifecycle: {
        onDispose: (fn: Function) => { disposeRegistered = true; },
      },
      theme: { current: {} },
    };

    await mod.tui(mockApi as any, undefined, {} as any);
    assert.ok(disposeRegistered, "lifecycle.onDispose was called");
  });

  it("all registrations succeed with full mock api", async () => {
    const mod = await loadMod();
    const calls: string[] = [];

    const fullApi = {
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
      lifecycle: { onDispose: () => { calls.push("lifecycle"); } },
      theme: { current: {} },
    };

    await mod.tui(fullApi as any, undefined, {} as any);
    assert.ok(calls.includes("slots"), "slots registered");
    assert.ok(calls.includes("route"), "route registered");
    assert.ok(calls.includes("command"), "command registered");
    assert.ok(calls.includes("lifecycle"), "lifecycle registered");
  });
});

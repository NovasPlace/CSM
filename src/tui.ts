import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

type MemoryStats = {
  totalMemories: number;
  recentSessions: number;
  lastCheckpoint: string | null;
  contextPressure: number;
  compactions: number;
};

const defaultStats: MemoryStats = {
  totalMemories: 0,
  recentSessions: 0,
  lastCheckpoint: null,
  contextPressure: 0,
  compactions: 0,
};

function readStats(kv: { get: (key: string, fallback: null) => unknown }): MemoryStats {
  try {
    const stored = kv.get("__csm_stats", null);
    if (stored && typeof stored === "object") {
      const s = stored as Record<string, unknown>;
      return {
        totalMemories: typeof s.totalMemories === "number" ? s.totalMemories : 0,
        recentSessions: typeof s.recentSessions === "number" ? s.recentSessions : 0,
        lastCheckpoint: typeof s.lastCheckpoint === "string" ? s.lastCheckpoint : null,
        contextPressure: typeof s.contextPressure === "number" ? s.contextPressure : 0,
        compactions: typeof s.compactions === "number" ? s.compactions : 0,
      };
    }
  } catch {}
  return defaultStats;
}

type HFn = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => unknown;

function formatPressure(p: number): string {
  if (p > 80) return "critical";
  if (p > 50) return "elevated";
  return "normal";
}

function pressureColor(p: number): string {
  if (p > 80) return "red";
  if (p > 50) return "yellow";
  return "green";
}

const mod: TuiPluginModule = {
  id: "opencode-cross-session-memory",

  tui: async (api) => {
    let h: HFn | null = null;
    try {
      const solidH = await import("solid-js/h");
      h = solidH.h as unknown as HFn;
    } catch {
      console.warn("[CrossSessionMemory] solid-js not available, TUI visual panel disabled (core tools unaffected)");
    }

    const disposes: (() => void)[] = [];

    try {
      api.slots.register({
        sidebar_content: (props: { session_id: string }) => {
          try {
            const s = readStats(api.kv);
            if (s.totalMemories === 0 || !h) return null;

            return h("box", { flexDirection: "column", padding: 1 },
              h("text", { style: "bold", color: "cyan" }, "  Memory"),
              h("text", {}, `  Memories: ${s.totalMemories}`),
              h("text", {}, `  Sessions: ${s.recentSessions}`),
              h("text", { color: pressureColor(s.contextPressure) },
                `  Pressure: ${s.contextPressure}% (${formatPressure(s.contextPressure)})`),
              h("text", {}, `  Compactions: ${s.compactions}`),
              s.lastCheckpoint
                ? h("text", { dim: true }, `  Last: ${new Date(s.lastCheckpoint).toLocaleString()}`)
                : null,
            );
          } catch (err) {
            console.warn("[CrossSessionMemory] sidebar_content render failed:", err);
            return null;
          }
        },
        sidebar_footer: (props: { session_id: string }) => {
          try {
            const s = readStats(api.kv);
            if (s.totalMemories === 0 || !h) return null;

            return h("text", { dim: true },
              `  ${s.totalMemories} mem | ${s.contextPressure}% ${formatPressure(s.contextPressure)}`);
          } catch (err) {
            console.warn("[CrossSessionMemory] sidebar_footer render failed:", err);
            return null;
          }
        },
      });
    } catch (err) {
      console.warn("[CrossSessionMemory] Slot registration failed:", err);
    }

    try {
      const routeDispose = api.route.register([{
        name: "memory",
        render: (_input: unknown) => {
          try {
            const s = readStats(api.kv);
            if (!h) return null;

            return h("box", { flexDirection: "column", padding: 1 },
              h("text", { style: "bold" }, "  Cross-Session Memory Dashboard"),
              h("text", {}, "  " + "─".repeat(40)),
              h("text", {}, `  Total Memories:    ${s.totalMemories}`),
              h("text", {}, `  Active Sessions:   ${s.recentSessions}`),
              h("text", { color: pressureColor(s.contextPressure) },
                `  Context Pressure:  ${s.contextPressure}% (${formatPressure(s.contextPressure)})`),
              h("text", {}, `  Compactions:       ${s.compactions}`),
              h("text", {}, `  Last Checkpoint:   ${s.lastCheckpoint ? new Date(s.lastCheckpoint).toLocaleString() : "none"}`),
            );
          } catch (err) {
            console.warn("[CrossSessionMemory] route render failed:", err);
            return h ? h("text", {}, "  Error loading memory stats") : null;
          }
        },
      }]);

      disposes.push(routeDispose);
    } catch (err) {
      console.warn("[CrossSessionMemory] Route registration failed:", err);
    }

    try {
      if (api.command) {
        const cmdDispose = api.command.register(() => [
          {
            title: "Memory Dashboard",
            value: "memory.dashboard",
            description: "Show cross-session memory statistics",
            category: "Memory",
            onSelect: () => {
              try { api.route.navigate("memory"); } catch {}
            },
          },
        ]);
        disposes.push(cmdDispose);
      }
    } catch (err) {
      console.warn("[CrossSessionMemory] Command registration failed:", err);
    }

    try {
      api.lifecycle.onDispose(() => {
        for (const fn of disposes) {
          try { fn(); } catch {}
        }
        disposes.length = 0;
      });
    } catch {}

    console.log("[CrossSessionMemory] TUI initialized");
  },
};

export default mod;

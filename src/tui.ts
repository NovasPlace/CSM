import type { TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui";
import pg from "pg";
import { getLogger } from "./logger.js";

type MemoryStats = {
  totalMemories: number;
  recentSessions: number;
  lastCheckpoint: string | null;
  contextPressure: number;
  compactions: number;
  providerStatus: string | null;
};

const defaultStats: MemoryStats = {
  totalMemories: 0,
  recentSessions: 0,
  lastCheckpoint: null,
  contextPressure: 0,
  compactions: 0,
  providerStatus: null,
};

const STATS_KEY = "__csm_stats";
const POLL_INTERVAL_MS = 5000;
const SQLITE_MODE = process.env.CSM_DATABASE_PROVIDER === "sqlite";
const DATABASE_URL =
  process.env.CSM_DATABASE_URL ||
  process.env.DATABASE_URL ||
  "postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory";

function readStats(kv: { get: (key: string, fallback: null) => unknown }): MemoryStats {
  try {
    const stored = kv.get(STATS_KEY, null);
    if (stored && typeof stored === "object") {
      const s = stored as Record<string, unknown>;
      return {
        totalMemories: typeof s.totalMemories === "number" ? s.totalMemories : 0,
        recentSessions: typeof s.recentSessions === "number" ? s.recentSessions : 0,
        lastCheckpoint: typeof s.lastCheckpoint === "string" ? s.lastCheckpoint : null,
        contextPressure: typeof s.contextPressure === "number" ? s.contextPressure : 0,
        compactions: typeof s.compactions === "number" ? s.compactions : 0,
        providerStatus: typeof s.providerStatus === "string" ? s.providerStatus : null,
      };
    }
     } catch (_e) {
       // Error reading stats, return defaults
     }
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

async function pollStats(api: TuiPluginApi): Promise<void> {
  if (SQLITE_MODE) {
    api.kv.set(STATS_KEY, {
      ...defaultStats,
      providerStatus: "SQLite core-memory mode: PostgreSQL dashboard metrics are unavailable",
    });
    return;
  }

  const { Pool } = pg;
  const pool = new Pool({
    connectionString: DATABASE_URL,
    max: 2,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 3000,
  });
  try {
    const [memResult, sessResult, ckptResult, compResult] = await Promise.all([
      pool.query("SELECT COUNT(*)::int AS n FROM memories"),
      pool.query(
        "SELECT COUNT(*)::int AS n FROM sessions WHERE updated_at > now() - interval '24 hours'",
      ),
      pool.query(
        "SELECT created_at FROM checkpoints ORDER BY created_at DESC LIMIT 1",
      ),
      pool.query(
        "SELECT COUNT(*)::int AS n FROM compaction_metrics WHERE created_at > now() - interval '24 hours'",
      ),
    ]);
    const stats: MemoryStats = {
      totalMemories: memResult.rows[0]?.n ?? 0,
      recentSessions: sessResult.rows[0]?.n ?? 0,
      lastCheckpoint: ckptResult.rows[0]?.created_at
        ? new Date(ckptResult.rows[0].created_at).toISOString()
        : null,
      contextPressure: 0,
      compactions: compResult.rows[0]?.n ?? 0,
      providerStatus: null,
    };
    api.kv.set(STATS_KEY, stats);
  } catch {
    // DB unreachable — leave stale stats in KV (if any)
  } finally {
    await pool.end().catch(() => {});
  }
}

const mod: TuiPluginModule = {
  id: "opencode-cross-session-memory",

  tui: async (api): Promise<void> => {
    let h: HFn | null = null;
    try {
      const solidH = await import("solid-js/h");
      h = (solidH.h ?? solidH.default) as unknown as HFn;
    } catch {
      getLogger().warn('solid-js not available, TUI visual panel disabled (core tools unaffected)');
    }

    const disposes: (() => void)[] = [];

    // Populate stats immediately, then on an interval
    pollStats(api).catch(() => {});
    const pollTimer = setInterval(() => pollStats(api).catch(() => {}), POLL_INTERVAL_MS);

    try {
      api.slots.register({
        sidebar_content: (_props: { session_id: string }) => {
          try {
            const s = readStats(api.kv);
            if (!h) return null;
            if (s.providerStatus) return h("text", { dim: true }, `  ${s.providerStatus}`);
            if (s.totalMemories === 0) return null;

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
           } catch (_err) {
            getLogger().warn('sidebar_content render failed');
            return null;
          }
        },
        sidebar_footer: (_props: { session_id: string }) => {
          try {
            const s = readStats(api.kv);
            if (!h) return null;
            if (s.providerStatus) return h("text", { dim: true }, `  ${s.providerStatus}`);
            if (s.totalMemories === 0) return null;

            return h("text", { dim: true },
              `  ${s.totalMemories} mem | ${s.contextPressure}% ${formatPressure(s.contextPressure)}`);
           } catch (_err) {
            getLogger().warn('sidebar_footer render failed');
            return null;
          }
        },
           });
           } catch (_err) {
             getLogger().warn('route render failed');
             return;
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
              s.providerStatus ? h("text", { color: "yellow" }, `  ${s.providerStatus}`) : null,
              h("text", {}, `  Total Memories:    ${s.totalMemories}`),
              h("text", {}, `  Active Sessions:   ${s.recentSessions}`),
              h("text", { color: pressureColor(s.contextPressure) },
                `  Context Pressure:  ${s.contextPressure}% (${formatPressure(s.contextPressure)})`),
              h("text", {}, `  Compactions:       ${s.compactions}`),
              h("text", {}, `  Last Checkpoint:   ${s.lastCheckpoint ? new Date(s.lastCheckpoint).toLocaleString() : "none"}`),
            );
           } catch (_err) {
             getLogger().warn('route render failed');
             return;
           }
        },
      }]);

       disposes.push(routeDispose);
     } catch (_err) {
      getLogger().warn('Route registration failed');
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
              try { api.route.navigate("memory"); } catch (_e) {
               // Navigation failed
             }
            },
          },
        ]);
        disposes.push(cmdDispose);
      }
    } catch (err) {
      getLogger().warn(`Command registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      api.lifecycle.onDispose(() => {
        clearInterval(pollTimer);
        for (const fn of disposes) {
           try { fn(); } catch (_e) {
             // Disposal failed
           }
        }
        disposes.length = 0;
       });
        } catch (_e) {
          // Lifecycle hook registration failed
        }

    getLogger().info('TUI initialized');
  },
};

export default mod;

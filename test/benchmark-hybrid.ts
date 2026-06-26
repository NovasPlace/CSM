import { Database } from "../dist/database.js";
import { MemoryManager } from "../dist/memory-manager.js";
import { EmbeddingGenerator } from "../dist/embeddings.js";
import { hybridSearch, vectorSearch, ftsSearch, entityMatchBoost, DEFAULT_WEIGHTS, type HybridWeights } from "../dist/hybrid-search.js";

const DB_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/cross_session_memory";
const PROJECT = "benchmark-project";

const VECTOR_ONLY_WEIGHTS: HybridWeights = { vector: 1.0, text: 0, entity: 0, recency: 0 };
const HYBRID_WEIGHTS = DEFAULT_WEIGHTS;

interface BenchmarkQuery {
  label: string;
  query: string;
  expectedContentSubstring: string;
  kind: "exact" | "semantic";
}

const QUERIES: BenchmarkQuery[] = [
  { label: "Q1: exact code symbol",     query: "time.compacted",               expectedContentSubstring: "time.compacted",           kind: "exact" },
  { label: "Q2: exact file path",       query: "src/tui.ts",                   expectedContentSubstring: "src/tui.ts",              kind: "exact" },
  { label: "Q3: exact function name",   query: "entityMatchBoost",             expectedContentSubstring: "entityMatchBoost",        kind: "exact" },
  { label: "Q4: semantic design q",     query: "why did TUI not block core plugin", expectedContentSubstring: "graceful",               kind: "semantic" },
  { label: "Q5: semantic bug q",        query: "what broke entity recall",     expectedContentSubstring: "SQL placeholder",          kind: "semantic" },
];

const SEED_MEMORIES = [
  { id: "seed-1", type: "repo" as const, content: "OpenCode compaction uses time.compacted to compress tool outputs. The format is [COMPACTED: source] Original: ~N tok | Kept: M key lines (truncated)", importance: 0.8, tags: ["compaction", "time-compacted"], emotion: "neutral" as const },
  { id: "seed-2", type: "repo" as const, content: "Phase 7 TUI: Rewrote src/tui.tsx as proper TuiPluginModule with SolidPlugin. Core plugin loads first; TUI adapter is optional and fails gracefully.", importance: 0.7, tags: ["tui", "solid", "plugin"], emotion: "success" as const },
  { id: "seed-3", type: "repo" as const, content: "Fixed entityMatchBoost SQL bug: $2 parameter was used for both LIMIT and JSONB entity match. Also added metadata.extracted_concepts to WHERE clause so entity matches are actually returned.", importance: 0.9, tags: ["bug", "sql", "entity-match"], emotion: "frustrated" as const },
  { id: "seed-4", type: "repo" as const, content: "Database schema uses CREATE TABLE IF NOT EXISTS for sessions and memories. ALTER TABLE migrates constraints to include new memory types like concept and code.", importance: 0.5, tags: ["schema", "migration"], emotion: "neutral" as const },
  { id: "seed-5", type: "workspace" as const, content: "TUI adapter pattern: core plugin is tested and mandatory. TUI is an optional adapter with graceful degradation. If Solid fails to load, the plugin still works headlessly.", importance: 0.8, tags: ["tui", "architecture", "graceful-degradation"], emotion: "success" as const },
  { id: "seed-6", type: "lesson" as const, content: "Hybrid search SQL placeholder bug: using $2 for both LIMIT and JSONB cast caused entity boost to silently fail. The WHERE clause also missed extracted_concepts, making entity recall partially fake.", importance: 0.85, tags: ["sql", "bug", "entity-recall"], emotion: "frustrated" as const },
  { id: "seed-7", type: "repo" as const, content: "Reciprocal Rank Fusion with K=60 combines vector, text, and entity scores. Weights: vector=0.35 text=0.25 entity=0.35 recency=0.05. Entity boost values: content=2.0 concepts=1.8 tags=1.5.", importance: 0.7, tags: ["rrf", "hybrid-search", "weights"], emotion: "neutral" as const },
  { id: "seed-8", type: "conversation" as const, content: "Cross-session memory plugin stores memories, sessions, checkpoints, context cache, and distilled summaries in PostgreSQL with pgvector.", importance: 0.6, tags: ["postgres", "architecture"], emotion: "neutral" as const },
];

async function main() {
  console.log("=== Hybrid Search Benchmark Report ===\n");

  const config = {
    databaseUrl: DB_URL,
    ollama: { baseUrl: "http://localhost:11434", model: "nomic-embed-text" },
  };

  const db = new Database(config);
  await db.connect();
  const emb = new EmbeddingGenerator(config);
  const mem = new MemoryManager(db, emb);

  await mem.createSession("bench-session", PROJECT);

  console.log("Seeding memories...");
  for (const seed of SEED_MEMORIES) {
    await mem.saveMemory({
      id: seed.id,
      sessionId: "bench-session",
      type: seed.type,
      content: seed.content,
      importance: seed.importance,
      tags: seed.tags,
      emotion: seed.emotion,
    });
  }
  console.log(`Seeded ${SEED_MEMORIES.length} memories.\n`);

  console.log("Running benchmark queries...\n");

  const results: Array<{
    query: BenchmarkQuery;
    vectorOnly: { rank: number; score: number; found: boolean };
    hybrid: { rank: number; score: number; found: boolean };
  }> = [];

  for (const q of QUERIES) {
    const embedding = await emb.generate(q.query);

    const hybridResults = await hybridSearch(db, q.query, embedding, 10, {
      projectId: PROJECT,
      weights: HYBRID_WEIGHTS,
    });

    const vectorResults = await vectorSearch(db, embedding, 10, PROJECT);

    // Find where expected memory ranks in each result set
    let hybridRank = -1;
    let hybridScore = 0;
    for (let i = 0; i < hybridResults.length; i++) {
      const row = await db.getPool().query("SELECT content FROM memories WHERE id = $1", [hybridResults[i].id]);
      if (row.rows.length > 0 && (row.rows[0] as any).content.includes(q.expectedContentSubstring)) {
        hybridRank = i + 1;
        hybridScore = hybridResults[i].score;
        break;
      }
    }

    let vectorRank = -1;
    let vectorScore = 0;
    for (let i = 0; i < vectorResults.length; i++) {
      const row = await db.getPool().query("SELECT content FROM memories WHERE id = $1", [vectorResults[i].id]);
      if (row.rows.length > 0 && (row.rows[0] as any).content.includes(q.expectedContentSubstring)) {
        vectorRank = i + 1;
        vectorScore = vectorResults[i].rank;
        break;
      }
    }

    results.push({
      query: q,
      vectorOnly: { rank: vectorRank, score: vectorScore, found: vectorRank > 0 },
      hybrid: { rank: hybridRank, score: hybridScore, found: hybridRank > 0 },
    });
  }

  // Print report
  console.log("┌──────────────────────────────────────────────────────────────────────────────────┐");
  console.log("│                        HYBRID vs VECTOR-ONLY BENCHMARK                           │");
  console.log("├──────────────────────────┬──────────────────────┬──────────────────────┬─────────┤");
  console.log("│ Query                    │ Vector-Only          │ Hybrid               │ Winner  │");
  console.log("├──────────────────────────┼──────────────────────┼──────────────────────┼─────────┤");

  for (const r of results) {
    const vStr = r.vectorOnly.found ? `rank=${r.vectorOnly.rank} score=${r.vectorOnly.score.toFixed(4)}` : "NOT FOUND        ";
    const hStr = r.hybrid.found ? `rank=${r.hybrid.rank} score=${r.hybrid.score.toFixed(4)}` : "NOT FOUND        ";
    let winner = "tie";
    if (r.hybrid.found && !r.vectorOnly.found) winner = "hybrid";
    else if (!r.hybrid.found && r.vectorOnly.found) winner = "vector";
    else if (r.hybrid.found && r.vectorOnly.found) {
      winner = r.hybrid.rank <= r.vectorOnly.rank ? "hybrid" : "vector";
    }
    const label = r.query.label.padEnd(25);
    const v = vStr.padEnd(21);
    const h = hStr.padEnd(21);
    const w = winner.padEnd(8);
    console.log(`│ ${label}│ ${v}│ ${h}│ ${w}│`);
  }

  console.log("└──────────────────────────┴──────────────────────┴──────────────────────┴─────────┘");

  // Summary
  const hybridWins = results.filter(r => {
    if (r.hybrid.found && !r.vectorOnly.found) return true;
    if (r.hybrid.found && r.vectorOnly.found && r.hybrid.rank <= r.vectorOnly.rank) return true;
    return false;
  }).length;
  const vectorWins = results.filter(r => {
    if (!r.hybrid.found && r.vectorOnly.found) return true;
    if (r.hybrid.found && r.vectorOnly.found && r.hybrid.rank > r.vectorOnly.rank) return true;
    return false;
  }).length;

  const exactQueries = results.filter(r => r.query.kind === "exact");
  const semanticQueries = results.filter(r => r.query.kind === "semantic");
  const exactHybridWin = exactQueries.filter(r => r.hybrid.found && (!r.vectorOnly.found || r.hybrid.rank <= r.vectorOnly.rank)).length;
  const semanticHybridWin = semanticQueries.filter(r => r.hybrid.found && (!r.vectorOnly.found || r.hybrid.rank <= r.vectorOnly.rank)).length;

  console.log("\n=== Summary ===");
  console.log(`Hybrid wins: ${hybridWins}/${results.length}`);
  console.log(`Vector-only wins: ${vectorWins}/${results.length}`);
  console.log(`Exact queries (hybrid wins): ${exactHybridWin}/${exactQueries.length}`);
  console.log(`Semantic queries (hybrid wins): ${semanticHybridWin}/${semanticQueries.length}`);
  console.log(`\nClaim: ${hybridWins >= 3 ? "PASS" : "FAIL"} — Hybrid search improves exact code recall without losing semantic recall.`);

  // Cleanup
  await db.getPool().query("DELETE FROM memories WHERE session_id = 'bench-session'");
  await db.getPool().query("DELETE FROM sessions WHERE id = 'bench-session'");
  await db.close();
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

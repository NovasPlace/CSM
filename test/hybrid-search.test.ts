import { it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Pool } from 'pg';
import { Database } from "../dist/database.js";
import { MemoryManager } from "../dist/memory-manager.js";
import { EmbeddingGenerator } from "../dist/embeddings.js";
import type { MemorySaveOptions, PluginConfig } from "../dist/types.js";

const BASE_DB_URL = process.env.CSM_DATABASE_URL
  ?? process.env.DATABASE_URL
  ?? 'postgresql://postgres:postgres@localhost:5432/cross_session_memory';

function databaseUrl(name: string): string {
  const url = new URL(BASE_DB_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

const FIXTURES: Array<Omit<MemorySaveOptions, 'sessionId'>> = [
  { content: 'function time.compacted() { return compactedContext(); }', type: 'code', importance: 0.9, emotion: 'neutral', confidence: 1, source: 'assistant', tags: ['time', 'compaction'] },
  { content: 'The ContextCompactor class handles compaction logic in src/tui.ts', type: 'code', importance: 0.8, emotion: 'neutral', confidence: 1, source: 'assistant', tags: ['compaction', 'context'] },
  { content: 'AGENT_PG_DSN environment variable must be set for database connection', type: 'config', importance: 0.7, emotion: 'neutral', confidence: 1, source: 'assistant', tags: ['config', 'database'] },
  { content: 'Migration failed with error: foreign key constraint violation on users table', type: 'error', importance: 0.9, emotion: 'frustrated', confidence: 1, source: 'assistant', tags: ['migration', 'error'] },
  { content: 'The compaction process reduces token usage by summarizing old context', type: 'concept', importance: 0.5, emotion: 'neutral', confidence: 1, source: 'assistant', tags: ['compaction', 'tokens'] },
  { content: 'Semantic search finds related concepts like memory management and context window', type: 'concept', importance: 0.4, emotion: 'neutral', confidence: 1, source: 'assistant', tags: ['search', 'memory'] },
];

async function seedMemories(mem: MemoryManager): Promise<void> {
  await mem.createSession('hybrid-test', 'test-project');
  for (const fixture of FIXTURES) {
    await mem.saveMemory({ ...fixture, sessionId: 'hybrid-test' });
  }
}

async function cleanupDatabase(
  admin: Pool,
  db: Database | undefined,
  databaseName: string,
  databaseCreated: boolean,
): Promise<void> {
  const errors: unknown[] = [];
  try { if (db) await db.close(); } catch (error) { errors.push(error); }
  if (databaseCreated) {
    try {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1', [databaseName]);
      await admin.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    } catch (error) { errors.push(error); }
  }
  try { await admin.end(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Hybrid-search database cleanup failed');
}

  const databaseName = `csm_hybrid_${Date.now()}`;
  const admin = new Pool({ connectionString: databaseUrl('postgres') });
  const config = {
    databaseUrl: databaseUrl(databaseName),
    databaseProvider: 'postgres',
    sqlitePath: '.data/csm-memory.db',
    embeddingModel: 'nomic-embed-text',
    embeddingApiUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  } as PluginConfig;
  let db: Database | undefined;
  let embeddings: EmbeddingGenerator;
  let mem: MemoryManager;
  let databaseCreated = false;

  before(async () => {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    db = new Database(config);
    await db.connect();
    embeddings = new EmbeddingGenerator(config);
    mem = new MemoryManager(db, embeddings);
    await seedMemories(mem);
  });

  it("exact function name 'time.compacted' beats semantic matches", async () => {
    const results = await mem.searchMemories({
      query: "time.compacted",
      projectId: "test-project",
      limit: 5,
      searchMode: "hybrid",
    });

    const top = results[0];
    assert.ok(top.memory.content.includes("time.compacted"), "Top result should contain exact function name");
    assert.ok(top.score > 0.5, "Score should be high for exact match");
  });

  it("exact file path 'src/tui.ts' beats semantic matches", async () => {
    const results = await mem.searchMemories({
      query: "src/tui.ts",
      projectId: "test-project",
      limit: 5,
      searchMode: "hybrid",
    });

    const top = results[0];
    assert.ok(top.memory.content.includes("src/tui.ts"), "Top result should contain exact file path");
  });

  it("exact class name 'ContextCompactor' beats semantic matches", async () => {
    const results = await mem.searchMemories({
      query: "ContextCompactor",
      projectId: "test-project",
      limit: 5,
      searchMode: "hybrid",
    });

    const top = results[0];
    assert.ok(top.memory.content.includes("ContextCompactor"), "Top result should contain exact class name");
  });

  it("exact env var 'AGENT_PG_DSN' beats semantic matches", async () => {
    const results = await mem.searchMemories({
      query: "AGENT_PG_DSN",
      projectId: "test-project",
      limit: 5,
      searchMode: "hybrid",
    });

    const top = results[0];
    assert.ok(top.memory.content.includes("AGENT_PG_DSN"), "Top result should contain exact env var");
  });

  it("exact error name 'foreign key constraint violation' beats semantic matches", async () => {
    const results = await mem.searchMemories({
      query: "foreign key constraint violation",
      projectId: "test-project",
      limit: 5,
      searchMode: "hybrid",
    });

    const top = results[0];
    assert.ok(top.memory.content.includes("foreign key constraint violation"), "Top result should contain exact error");
  });

  it("semantic query 'how does compaction work' still finds relevant memories", async () => {
    const results = await mem.searchMemories({
      query: "how does compaction work",
      projectId: "test-project",
      limit: 5,
      searchMode: "hybrid",
    });

    assert.ok(results.length >= 2, "Should find multiple compaction-related memories");
    const compactionCount = results.filter(r => r.memory.content.toLowerCase().includes("compaction")).length;
    assert.ok(compactionCount >= 2, "Should find compaction-related memories semantically");
  });

  it("vector-only fallback works when searchMode is vector", async () => {
    const results = await mem.searchMemories({
      query: "time.compacted",
      projectId: "test-project",
      limit: 5,
      searchMode: "vector",
    });

    // Should still work, just using vector similarity
    assert.ok(results.length >= 1, "Vector-only search should return results");
  });

  after(async () => {
    await cleanupDatabase(admin, db, databaseName, databaseCreated);
  });

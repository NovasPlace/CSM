import { Database } from '../src/database.js';
import { MemoryManager } from '../src/memory-manager.js';
import { EmbeddingGenerator } from '../src/embeddings.js';
import { Redactor } from '../src/redactor.js';
import { validateAndReturnConfig } from '../src/config.js';

const config = validateAndReturnConfig();
const database = new Database(config);
const embeddings = new EmbeddingGenerator(config);
const redactor = new Redactor(config.redactor);
const memoryManager = new MemoryManager(database, embeddings, redactor);

async function main() {
  await database.connect();
  const pool = database.getPool();
  console.log('=== CSM SYSTEM AUDIT ===\n');

  // 1. Core tables row counts
  console.log('--- Table Row Counts ---');
  const tables = ['memories', 'memory_chunks', 'sessions', 'memory_events', 'memory_recall_events', 'memory_links', 'memory_merges', 'memory_quality_scores', 'distilled_summaries', 'agent_work_journal'];
  for (const t of tables) {
    try {
      const r = await pool.query(`SELECT COUNT(*) as cnt FROM ${t}`);
      console.log(`  ${t.padEnd(25)} ${String(r.rows[0].cnt).padStart(7)}`);
    } catch (e) {
      console.log(`  ${t.padEnd(25)} MISSING/ERROR`);
    }
  }

  // 2. Embedding coverage
  console.log('\n--- Embedding Coverage ---');
  const emb = await pool.query(`SELECT COUNT(*) FILTER (WHERE embedding IS NOT NULL) as with_emb, COUNT(*) as total FROM memories`);
  console.log(`  With embeddings: ${emb.rows[0].with_emb} / ${emb.rows[0].total}`);

  // 3. Memory type distribution
  console.log('\n--- Memory Types ---');
  const types = await pool.query(`SELECT memory_type, COUNT(*) as cnt FROM memories GROUP BY memory_type ORDER BY cnt DESC`);
  for (const r of types.rows) console.log(`  ${String(r.memory_type).padEnd(15)} ${String(r.cnt).padStart(7)}`);

  // 4. Recent lessons (last 5)
  console.log('\n--- Recent Lessons ---');
  const lessons = await memoryManager.listMemories({ type: 'lesson', limit: 5, sortBy: 'recent' });
  for (const m of lessons) console.log(`  #${m.id} imp=${m.importance} | ${m.content.substring(0, 100).replace(/\n/g, ' ')}`);

  // 5. Recall events (last 24h)
  console.log('\n--- Recall Events (last 24h) ---');
  const recall = await pool.query(`SELECT COUNT(*) as cnt, COUNT(DISTINCT memory_id) as uniq FROM memory_recall_events WHERE recalled_at > NOW() - INTERVAL '24 hours'`);
  console.log(`  Events: ${recall.rows[0].cnt}, Unique memories: ${recall.rows[0].uniq}`);

  // 6. Work journal entries (last 24h)
  console.log('\n--- Work Journal (last 24h) ---');
  const journal = await pool.query(`SELECT COUNT(*) as cnt FROM agent_work_journal WHERE created_at > NOW() - INTERVAL '24 hours'`);
  console.log(`  Entries: ${journal.rows[0].cnt}`);

  // 7. Distilled summaries (last 24h)
  console.log('\n--- Distilled Summaries (last 24h) ---');
  const distill = await pool.query(`SELECT COUNT(*) as cnt FROM distilled_summaries WHERE built_at > NOW() - INTERVAL '24 hours'`);
  console.log(`  Summaries: ${distill.rows[0].cnt}`);

  // 8. Superseded/archived memories
  console.log('\n--- Archive Status ---');
  const arch = await pool.query(`SELECT COUNT(*) FILTER (WHERE superseded_by IS NOT NULL) as superseded, COUNT(*) FILTER (WHERE archived_at IS NOT NULL) as archived FROM memories`);
  console.log(`  Superseded: ${arch.rows[0].superseded}, Archived: ${arch.rows[0].archived}`);

  // 9. Search smoke test
  console.log('\n--- Search Smoke Test ---');
  const searchResults = await memoryManager.searchMemories({ query: 'sqlite database', limit: 3 });
  console.log(`  Query "sqlite database": ${searchResults.length} results`);
  for (const r of searchResults.slice(0, 2)) console.log(`    #${r.memory.id} score=${r.score.toFixed(2)} | ${r.memory.content.substring(0, 80).replace(/\n/g, ' ')}`);

  // 10. Embedding generation test
  console.log('\n--- Embedding Generation Test ---');
  try {
    const vec = await embeddings.generate('test embedding generation');
    console.log(`  OK: dim=${vec.length}`);
  } catch (e) {
    console.log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }

  console.log('\n=== AUDIT COMPLETE ===');
  await database.disconnect();
}

main().catch(e => { console.error('Audit failed:', e); process.exit(1); });

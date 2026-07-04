#!/usr/bin/env tsx
/**
 * Desktop-level CLI for cross-session memory, using the full plugin runtime.
 * Usage: npm run csm -- <command> [args]
 */
import { Database } from '../src/database.js';
import { MemoryManager } from '../src/memory-manager.js';
import { EmbeddingGenerator } from '../src/embeddings.js';
import { Redactor } from '../src/redactor.js';
import { validateAndReturnConfig } from '../src/config.js';
import type { MemoryType } from '../src/types.js';

const config = validateAndReturnConfig();
const database = new Database(config);
const embeddings = new EmbeddingGenerator(config);
const redactor = new Redactor(config.redactor);
const memoryManager = new MemoryManager(database, embeddings, redactor);

interface CliFlags {
  [key: string]: string | undefined;
}

function parseFlags(args: string[]): { positional: string[]; flags: CliFlags } {
  const positional: string[] = [];
  const flags: CliFlags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      flags[key] = args[++i] ?? 'true';
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help') { printHelp(); return; }

  await database.connect();

  try {
    switch (cmd) {
      case 'query':    await cmdQuery(process.argv.slice(3).join(' ')); break;
      case 'recent':   await cmdRecent(parseInt(process.argv[3] ?? '5')); break;
      case 'lessons':  await cmdLessons(parseInt(process.argv[3] ?? '5')); break;
      case 'type':     await cmdType(process.argv[3], parseInt(process.argv[4] ?? '10')); break;
      case 'stats':    await cmdStats(); break;
      case 'save':     await cmdSave(process.argv.slice(3)); break;
      case 'lesson':   await cmdLesson(process.argv.slice(3)); break;
      case 'delete':   await cmdDelete(parseInt(process.argv[3] ?? '0')); break;
      default: console.log(`Unknown command: ${cmd}`); printHelp();
    }
  } finally {
    await database.disconnect();
  }
}

/* ---- Read ---- */

async function cmdQuery(text: string) {
  if (!text) { console.log('Usage: csm query <text>'); return; }
  const results = await memoryManager.searchMemories({ query: text, limit: 10 });
  printMemories(results.map(r => r.memory), `Memories matching "${text}"`);
}

async function cmdRecent(n: number) {
  const memories = await memoryManager.listMemories({ limit: n, sortBy: 'recent' });
  printMemories(memories, `Recent ${n} memories`);
}

async function cmdLessons(n: number) {
  const memories = await memoryManager.listMemories({ type: 'lesson', limit: n, sortBy: 'important' });
  printMemories(memories, `Top ${n} lessons`);
}

async function cmdType(type: string | undefined, n: number) {
  if (!type) { console.log('Usage: csm type <memory_type> [n]'); return; }
  const memories = await memoryManager.listMemories({ type: type as MemoryType, limit: n, sortBy: 'important' });
  printMemories(memories, `Top ${n} memories of type "${type}"`);
}

async function cmdStats() {
  const pool = database.getPool();
  const r = await pool.query(
    `SELECT memory_type, COUNT(*) as cnt FROM memories GROUP BY memory_type ORDER BY cnt DESC`
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const total = r.rows.reduce((s: number, row: any) => s + parseInt(row.cnt, 10), 0);
  console.log(`Total memories: ${total}\n`);
  console.log('Type distribution:');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const row of r.rows) {
    console.log(`  ${String(row.memory_type).padEnd(15)} ${String(row.cnt).padStart(6)}`);
  }
}

/* ---- Write ---- */

async function cmdSave(args: string[]) {
  const { positional, flags } = parseFlags(args);
  const content = positional.join(' ');
  if (!content) { console.log('Usage: csm save <content> [--type TYPE] [--importance N] [--tags a,b,c]'); return; }

  const memoryType = (flags['type'] ?? 'workspace') as MemoryType;
  const importance = parseFloat(flags['importance'] ?? '0.7');
  const tags = flags['tags'] ? flags['tags']!.split(',').map(t => t.trim()) : [];

  const memory = await memoryManager.saveMemory({
    content,
    type: memoryType,
    importance,
    emotion: 'neutral',
    confidence: 1.0,
    source: 'manual',
    tags,
  });
  console.log(`Saved memory #${memory.id} [${memoryType}] (importance: ${importance})`);
}

async function cmdLesson(args: string[]) {
  const { positional, flags } = parseFlags(args);
  const content = positional.join(' ');
  if (!content) { console.log('Usage: csm lesson <content> [--frustration N] [--tags a,b,c]'); return; }

  const frustration = parseFloat(flags['frustration'] ?? '0.7');
  const tags = ['lesson', 'learned', ...(flags['tags'] ? flags['tags']!.split(',').map(t => t.trim()) : [])];
  const metadata: Record<string, unknown> = { frustration };

  const memory = await memoryManager.saveMemory({
    content,
    type: 'lesson',
    importance: 0.75,
    emotion: 'frustration',
    confidence: 0.9,
    source: 'lesson',
    tags,
    metadata,
  });
  console.log(`Saved lesson #${memory.id} (frustration: ${frustration})`);
}

async function cmdDelete(id: number) {
  if (!id) { console.log('Usage: csm delete <id>'); return; }
  const deleted = await memoryManager.deleteMemory(id);
  if (deleted) {
    console.log(`Deleted memory #${id}`);
  } else {
    console.log(`Memory #${id} not found`);
  }
}

/* ---- Output ---- */

function printMemories(memories: import('../src/types.js').Memory[], title: string) {
  if (memories.length === 0) { console.log('No results.'); return; }
  console.log(`=== ${title} ===\n`);
  for (const m of memories) {
    const date = m.createdAt ? new Date(m.createdAt).toISOString().substring(0, 19) : '';
    const preview = m.content.substring(0, 160).replace(/\n/g, ' ');
    console.log(`  #${m.id} [${m.memoryType}] ${m.importance}${date ? '  ' + date : ''}`);
    console.log(`  ${preview}${m.content.length > 160 ? '...' : ''}`);
    console.log();
  }
}

function printHelp() {
  console.log(`Cross-Session Memory Tool (full pipeline)

Usage: npm run csm -- <command> [args]

Read:
  query  <text>               Search memories (semantic + FTS)
  recent [n]                  Show N most recent memories (default 5)
  lessons [n]                 Show top N lessons (default 5)
  type   <type> [n]           List memories of a given type
  stats                       Show memory type distribution

Write (full pipeline - embeddings, quality scoring, etc):
  save   <content> [opts]     Save a memory
    --type TYPE               Memory type (default: workspace)
    --importance N            Importance 0-1 (default: 0.7)
    --tags a,b,c              Comma-separated tags
  lesson <content> [opts]     Save a lesson
    --frustration N           Frustration 0-1 (default: 0.7)
    --tags a,b,c              Comma-separated tags
  delete <id>                 Delete a memory by ID`);
}

main().catch(e => {
  console.error('Error:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});

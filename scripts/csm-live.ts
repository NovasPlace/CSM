import { Database } from '../src/database.js';
import { validateAndReturnConfig } from '../src/config.js';

const config = validateAndReturnConfig();
const database = new Database(config);
await database.connect();
const pool = database.getPool();

console.log('=== IS THE PLUGIN CAPTURING RIGHT NOW? ===\n');

// 1. Auto-captured memories in last 2 days by source
const r1 = await pool.query("SELECT source, COUNT(*) as cnt FROM memories WHERE created_at > NOW() - INTERVAL '2 days' GROUP BY source ORDER BY cnt DESC");
console.log('--- Memories captured (last 2 days) ---');
if (r1.rows.length === 0) console.log('  NONE');
for (const r of r1.rows) console.log(`  ${String(r.source).padEnd(20)} ${r.cnt}`);

// 2. memory_events columns
const r2 = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'memory_events' ORDER BY ordinal_position");
console.log('\n--- memory_events columns ---');
console.log('  ' + r2.rows.map(r => r.column_name).join(', '));

// 3. Recent memory_events
const r3 = await pool.query('SELECT * FROM memory_events ORDER BY created_at DESC LIMIT 3');
console.log('\n--- Last 3 memory_events ---');
for (const r of r3.rows) console.log('  ' + JSON.stringify(r).substring(0, 200));

// 4. Recall events: are they from plugin or from my CLI scripts?
const r4 = await pool.query("SELECT source, COUNT(*) as cnt FROM memory_recall_events WHERE recalled_at > NOW() - INTERVAL '2 hours' GROUP BY source ORDER BY cnt DESC");
console.log('\n--- Recall events (last 2h) by source ---');
if (r4.rows.length === 0) console.log('  NONE');
for (const r of r4.rows) console.log(`  ${String(r.source).padEnd(20)} ${r.cnt}`);

// 5. Is there a session for THIS conversation?
const r5 = await pool.query("SELECT id, created_at FROM sessions WHERE created_at > NOW() - INTERVAL '6 hours' ORDER BY created_at DESC");
console.log('\n--- Sessions (last 6 hours) ---');
if (r5.rows.length === 0) console.log('  NONE — no session tracked for current conversation');
for (const r of r5.rows) console.log(`  ${r.id}  ${new Date(r.created_at).toISOString()}`);

await database.disconnect();

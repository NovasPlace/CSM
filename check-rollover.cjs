const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory' });

async function main() {
  // 1. Check context_cache entries for recent sessions
  const cache = await p.query(
    "SELECT session_id, COUNT(*) as items, SUM(tokens) as total_tokens, MIN(created_at) as first, MAX(created_at) as last FROM context_cache GROUP BY session_id ORDER BY last DESC LIMIT 10"
  );
  console.log("=== context_cache by session ===");
  console.log(JSON.stringify(cache.rows, null, 2));

  // 2. Check if any rollover happened (look for continuation briefs in context_cache)
  const rollovers = await p.query(
    "SELECT session_id, display_id, kind, LEFT(summary, 100) as summary_preview, tokens, created_at FROM context_cache WHERE kind LIKE '%rollover%' OR kind LIKE '%continuation%' OR display_id LIKE '%rollover%' ORDER BY created_at DESC LIMIT 10"
  );
  console.log("\n=== rollover/continuation entries ===");
  console.log(JSON.stringify(rollovers.rows, null, 2));

  // 3. Check compilation logs for governor actions
  const logs = await p.query(
    "SELECT session_id, mode, budget, before_tokens, after_tokens, parts_compressed, parts_pinned, created_at FROM compilation_log ORDER BY created_at DESC LIMIT 15"
  );
  console.log("\n=== recent compilation_log entries ===");
  console.log(JSON.stringify(logs.rows, null, 2));

  // 4. Check for the current session specifically
  const sid = 'ses_0eeaa4279ffesoSGtXhDCqUhM5';
  const currentCache = await p.query(
    "SELECT COUNT(*) as items, SUM(tokens) as total_tokens FROM context_cache WHERE session_id = $1",
    [sid]
  );
  console.log("\n=== current session context_cache ===");
  console.log(JSON.stringify(currentCache.rows, null, 2));

  const currentLogs = await p.query(
    "SELECT mode, budget, before_tokens, after_tokens, parts_compressed, parts_pinned, created_at FROM compilation_log WHERE session_id = $1 ORDER BY created_at DESC LIMIT 10",
    [sid]
  );
  console.log("\n=== current session compilation_log ===");
  console.log(JSON.stringify(currentLogs.rows, null, 2));

  await p.end();
}

main().catch(e => { console.error(e); p.end(); });

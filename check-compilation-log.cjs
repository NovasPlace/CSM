const { Pool } = require('pg');
const p = new Pool({ connectionString: 'postgresql://opencode_memory:opencode_memory@localhost:5432/opencode_memory' });

async function main() {
  // Check actual table name
  const tables = await p.query(
    "SELECT table_name FROM information_schema.tables WHERE table_name LIKE '%compilation%' OR table_name LIKE '%context%'"
  );
  console.log("=== tables matching compilation/context ===");
  console.log(JSON.stringify(tables.rows, null, 2));

  // Check if context_compilation_log has data
  try {
    const data = await p.query(
      "SELECT COUNT(*) as cnt FROM context_compilation_log"
    );
    console.log("\n=== context_compilation_log count ===");
    console.log(JSON.stringify(data.rows, null, 2));

    const recent = await p.query(
      "SELECT session_id, mode, budget, before_tokens, after_tokens, parts_compressed, created_at FROM context_compilation_log ORDER BY created_at DESC LIMIT 10"
    );
    console.log("\n=== recent entries ===");
    console.log(JSON.stringify(recent.rows, null, 2));
  } catch (e) {
    console.log("\n=== context_compilation_log error ===");
    console.log(e.message);
  }

  await p.end();
}

main().catch(e => { console.error(e); p.end(); });

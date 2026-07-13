import { Database } from '../src/database.js';
import { DEFAULT_CONFIG } from '../src/config.js';

async function main(): Promise<void> {
  const db = new Database(DEFAULT_CONFIG);
  await db.connect();
  await db.close();
  console.log('Database schema initialized successfully');
}

main().catch((err) => {
  console.error('Schema initialization failed:', err);
  process.exit(1);
});

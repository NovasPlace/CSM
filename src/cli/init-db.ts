#!/usr/bin/env node

import { validateAndReturnConfig } from '../config.js';
import { Database } from '../database.js';

async function main(): Promise<void> {
  const database = new Database(validateAndReturnConfig());
  try {
    await database.connect();
    process.stdout.write('CSM database schema initialized successfully\n');
  } finally {
    await database.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`CSM schema initialization failed: ${message}\n`);
  process.exitCode = 1;
});

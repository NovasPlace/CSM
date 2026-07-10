import plugin from '../dist/index.js';
import { writeFile } from 'node:fs/promises';

const workspace = process.argv[2];
const hooks = await plugin.server(
  { directory: workspace, worktree: workspace, client: {} },
  { databaseProvider: 'sqlite', sqlitePath: process.env.CSM_SQLITE_PATH },
);
const output = { system: [] };
await hooks['experimental.chat.system.transform']({
  sessionID: 'sqlite-lifecycle-session',
  messages: [{ role: 'user', content: 'inspect the current project' }],
}, output);

if (output.system.length === 0) throw new Error('expected a system prompt injection');
if (!hooks.tool.csm_memory_save || hooks.tool.create_checkpoint || hooks.tool.csm_memory_dedup_detect) {
  throw new Error('SQLite tool capability profile is incorrect');
}

const initialSystem = output.system.join('\n');
if (/SqliteError|no such table|syntax error/i.test(initialSystem)) {
  throw new Error(`unsafe SQLite startup injection: ${initialSystem}`);
}

const editPath = `${workspace}/sqlite-edit.txt`;
const editInput = {
  tool: 'edit', sessionID: 'sqlite-lifecycle-session', callID: 'sqlite-edit',
  args: { filePath: editPath },
};
await hooks['tool.execute.before'](editInput, { args: editInput.args });
await writeFile(editPath, 'SQLite edit capture provider boundary\n');
await hooks['tool.execute.after'](editInput, {
  title: 'edited', output: 'ok', metadata: {},
});

await hooks.tool.csm_memory_save.execute({
  content: 'SQLiteCascade lifecycle saved src/review-filter.ts for enterprise filter coverage.',
  type: 'lesson',
  tags: ['tool:bash'],
}, { sessionID: 'sqlite-lifecycle-session' });
await hooks.tool.csm_memory_save.execute({
  content: 'SQLiteCascade lifecycle validates two-result priming and date filtering.',
  type: 'lesson',
  tags: ['tool:bash'],
}, { sessionID: 'sqlite-lifecycle-session' });

const searchResult = await hooks.tool.csm_memory_search.execute({
  query: 'SQLiteCascade',
  limit: 10,
}, { sessionID: 'sqlite-lifecycle-session' });
if (searchResult.metadata.count < 2 || searchResult.metadata.cascadedCount < 2) {
  throw new Error(`SQLite two-hit search failed: ${JSON.stringify(searchResult.metadata)}`);
}

const listResult = await hooks.tool.csm_memory_list.execute({
  startDate: new Date(Date.now() - 3_600_000).toISOString(),
  entityType: 'file',
  entityValue: 'src/review-filter.ts',
  limit: 10,
}, { sessionID: 'sqlite-lifecycle-session' });
if (listResult.metadata.count !== 1) {
  throw new Error(`SQLite date/entity list failed: ${JSON.stringify(listResult.metadata)}`);
}

await hooks['tool.execute.after']({
  tool: 'bash',
  sessionID: 'sqlite-lifecycle-session',
  callID: 'sqlite-failed-tool',
  args: { command: 'exit 1' },
}, {
  title: 'Expected failure',
  output: 'command failed as expected',
  metadata: { exitCode: 1, error: 'expected regression failure' },
});

const lessonOutput = { system: [] };
await hooks['experimental.chat.system.transform']({
  sessionID: 'sqlite-lesson-session',
  messages: [{ role: 'user', content: 'use the saved lesson' }],
}, lessonOutput);

const lessonSystem = lessonOutput.system.join('\n');
if (!lessonSystem.includes('SQLiteCascade lifecycle saved src/review-filter.ts')) {
  throw new Error('SQLite lesson was not injected after refresh');
}
if (/SqliteError|no such table|syntax error/i.test(lessonSystem)) {
  throw new Error(`unsafe SQLite lesson injection: ${lessonSystem}`);
}

await hooks.dispose();

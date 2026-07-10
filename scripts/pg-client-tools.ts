import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

export interface PgClientTools {
  dump: string;
  restore: string;
  major: number;
}

interface ProcessResult {
  stdout: string;
  stderr: string;
}

const VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const FORCE_KILL_DELAY_MS = 1_000;
const SECRET_QUERY_KEYS = new Set(['password', 'passfile', 'sslpassword']);

export async function readServerMajor(admin: Pool): Promise<number> {
  const result = await admin.query<{ version_num: string }>(
    "SELECT current_setting('server_version_num') AS version_num",
  );
  const versionNum = Number(result.rows[0]?.version_num);
  const major = Math.floor(versionNum / 10000);
  if (!Number.isInteger(major) || major < 14) {
    throw new Error(`Unsupported PostgreSQL server_version_num: ${versionNum}`);
  }
  return major;
}

export async function resolvePgClientTools(serverMajor: number): Promise<PgClientTools> {
  const dump = resolveCandidate('pg_dump', serverMajor);
  const restore = resolveCandidate('pg_restore', serverMajor);
  const dumpMajor = await readToolMajor(dump);
  const restoreMajor = await readToolMajor(restore);
  if (dumpMajor !== serverMajor || restoreMajor !== serverMajor) {
    throw new Error(
      `PostgreSQL client/server mismatch: server=${serverMajor}, pg_dump=${dumpMajor}, pg_restore=${restoreMajor}`,
    );
  }
  return { dump, restore, major: serverMajor };
}

export async function runPgTool(
  program: string,
  args: string[],
  password: string,
): Promise<void> {
  const result = await runProcess(
    program,
    args,
    { ...process.env, PGPASSWORD: password },
    toolTimeoutMs(),
  );
  if (result.stderr.trim()) process.stderr.write(result.stderr);
}

export function parsePgToolMajor(versionOutput: string): number {
  const match = versionOutput.match(/\(PostgreSQL\)\s+(\d+)/);
  if (!match) throw new Error(`Unable to parse PostgreSQL client version: ${versionOutput.trim()}`);
  return Number(match[1]);
}

export function sanitizedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  url.password = '';
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url.toString();
}

export function decodeDatabasePassword(databaseUrl: string): string {
  return decodeURIComponent(new URL(databaseUrl).password);
}

async function readToolMajor(program: string): Promise<number> {
  const result = await runProcess(program, ['--version'], process.env, VERSION_TIMEOUT_MS);
  return parsePgToolMajor(result.stdout || result.stderr);
}

function resolveCandidate(tool: string, serverMajor: number): string {
  const executable = process.platform === 'win32' ? `${tool}.exe` : tool;
  const configured = process.env.CSM_PG_BIN;
  if (configured) return join(configured, executable);
  if (process.platform !== 'win32') return executable;
  const candidate = join(
    'C:\\Program Files\\PostgreSQL',
    String(serverMajor),
    'bin',
    executable,
  );
  if (existsSync(candidate)) return candidate;
  throw new Error(`PostgreSQL ${serverMajor} client tool not found: ${candidate}`);
}

function runProcess(
  program: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeoutError: Error | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timeoutError = new Error(`${program} timed out after ${timeoutMs}ms`);
      child.kill();
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), FORCE_KILL_DELAY_MS);
    }, timeoutMs);
    const finish = (error?: Error, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve(result ?? { stdout, stderr });
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (timeoutError) finish(timeoutError);
      else if (code === 0) finish(undefined, { stdout, stderr });
      else finish(new Error(`${program} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function toolTimeoutMs(): number {
  const configured = Number(process.env.CSM_PG_TOOL_TIMEOUT_MS ?? DEFAULT_TOOL_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 1_000) {
    throw new Error('CSM_PG_TOOL_TIMEOUT_MS must be at least 1000');
  }
  return Math.floor(configured);
}

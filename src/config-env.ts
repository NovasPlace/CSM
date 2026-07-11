import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function loadDotEnv(
  cwd: string = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = resolve(cwd, '.env');
  if (!existsSync(path)) return;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read environment file: ${path}`, { cause: error });
  }
  const parsed = parseDotEnv(text);
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function parseDotEnv(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const separator = line.indexOf('=');
    if (separator < 1) throw envLineError(index, 'expected KEY=VALUE');
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY.test(key)) throw envLineError(index, 'invalid variable name');
    parsed[key] = parseDotEnvValue(line.slice(separator + 1).trim(), index);
  }
  return parsed;
}

export function getEnvString(
  key: string,
  defaultValue?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[key] ?? defaultValue;
}

export function getEnvBoolean(
  key: string,
  defaultValue = false,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[key];
  if (value === undefined) return defaultValue;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  throw new Error(`${key} must be true or false`);
}

export function getEnvNumber(
  key: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = env[key];
  if (value === undefined) return defaultValue;
  if (!ENV_NUMBER.test(value)) throw new Error(`${key} must be a finite number`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a finite number`);
  return parsed;
}

export function getEnvInteger(
  key: string,
  defaultValue: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const value = getEnvNumber(key, defaultValue, env);
  if (!Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function parseDotEnvValue(value: string, index: number): string {
  if (!value.startsWith('"') && !value.startsWith("'")) {
    return value.replace(/\s+#.*$/, '').trimEnd();
  }
  const quote = value[0];
  const closing = closingQuoteIndex(value, quote);
  if (closing < 0) throw envLineError(index, 'unterminated quoted value');
  const trailing = value.slice(closing + 1).trim();
  if (trailing && !trailing.startsWith('#')) throw envLineError(index, 'unexpected text after quoted value');
  return value.slice(1, closing);
}

function closingQuoteIndex(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '\\') { index += 1; continue; }
    if (value[index] === quote) return index;
  }
  return -1;
}

function envLineError(index: number, reason: string): Error {
  return new Error(`Invalid .env line ${index + 1}: ${reason}`);
}

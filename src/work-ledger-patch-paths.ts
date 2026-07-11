import { TextDecoder } from 'node:util';

export function extractPatchPaths(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return [];
  const lines = value.split('\n');
  return [
    ...extractOpenAiFilePaths(lines),
    ...extractMovePaths(lines),
    ...extractUnifiedPaths(lines),
  ];
}

function extractOpenAiFilePaths(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('*** ')) continue;
    const rest = line.slice(4);
    if (!isOpenAiFileHeader(rest)) continue;
    const path = rest.slice(rest.indexOf(':') + 1).trim();
    if (path && path !== '/dev/null') paths.push(path);
  }
  return paths;
}

function extractMovePaths(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('*** Move to:')) continue;
    const path = line.slice('*** Move to:'.length).trim();
    if (path && path !== '/dev/null') paths.push(path);
  }
  return paths;
}

function extractUnifiedPaths(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    const path = parseUnifiedPath(line);
    if (path) paths.push(path);
  }
  return paths;
}

function parseUnifiedPath(line: string): string | undefined {
  if (!line.startsWith('--- ') && !line.startsWith('+++ ')) return undefined;
  const field = readPathField(line.slice(4));
  if (!field) return undefined;
  const decoded = field.startsWith('"') ? decodeGitQuotedPath(field) : field;
  if (!decoded || decoded === '/dev/null') return undefined;
  return decoded.startsWith('a/') || decoded.startsWith('b/')
    ? decoded.slice(2)
    : decoded;
}

function readPathField(value: string): string | undefined {
  if (!value.startsWith('"')) return value.split('\t', 1)[0].replace(/\r$/, '');
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === '"' && !escaped) return value.slice(0, index + 1);
    if (value[index] === '\\' && !escaped) escaped = true;
    else escaped = false;
  }
  return undefined;
}

function decodeGitQuotedPath(value: string): string | undefined {
  const bytes = decodeGitQuotedBytes(value);
  if (!bytes) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeGitQuotedBytes(value: string): Buffer | undefined {
  const chunks: Buffer[] = [];
  for (let index = 1; index < value.length - 1; index += 1) {
    const current = value[index];
    if (current !== '\\') {
      const point = value.codePointAt(index);
      if (point === undefined) return undefined;
      chunks.push(Buffer.from(String.fromCodePoint(point)));
      if (point > 0xffff) index += 1;
      continue;
    }
    const next = value[index + 1] ?? '';
    if (isOctalDigit(next)) {
      const octal = readOctal(value, index + 1);
      if (!octal) return undefined;
      chunks.push(Buffer.from([Number.parseInt(octal.value, 8)]));
      index = octal.end - 1;
      continue;
    }
    const escaped = decodeEscape(next);
    if (escaped === undefined) return undefined;
    chunks.push(Buffer.from(escaped));
    index += 1;
  }
  return Buffer.concat(chunks);
}

function readOctal(value: string, start: number): { value: string; end: number } | undefined {
  const digits = value.slice(start, start + 3);
  if (digits.length !== 3 || [...digits].some((digit) => !isOctalDigit(digit))) return undefined;
  return { value: digits, end: start + 3 };
}

function decodeEscape(value: string): string | undefined {
  const escapes: Record<string, string> = {
    a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r',
    '"': '"', '\\': '\\',
  };
  return escapes[value];
}

function isOctalDigit(value: string): boolean {
  return value >= '0' && value <= '7';
}

function isOpenAiFileHeader(value: string): boolean {
  return value.startsWith('Add File:')
    || value.startsWith('Update File:')
    || value.startsWith('Delete File:');
}

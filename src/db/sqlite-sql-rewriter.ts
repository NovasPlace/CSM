export interface RewrittenSql {
  sql: string;
  params: unknown[];
}

const IDENTIFIER = '(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_]*)';
const TYPE_NAME = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})*`;
const TYPE_WORDS = '(?:\\s+(?:precision|varying|with\\s+time\\s+zone|without\\s+time\\s+zone))?';
const TYPE_MODIFIER = '(?:\\s*\\(\\s*\\d+(?:\\s*,\\s*\\d+)*\\s*\\))?';
const ARRAY_SUFFIX = '(?:\\s*\\[\\s*\\])*';
const CAST_PATTERN = new RegExp(`^::\\s*${TYPE_NAME}${TYPE_WORDS}${TYPE_MODIFIER}${ARRAY_SUFFIX}`, 'i');

export function rewriteSqliteSql(sql: string, params: readonly unknown[] = []): RewrittenSql {
  const output: string[] = [];
  const mapped: unknown[] = [];
  const used = new Set<number>();
  let index = 0;
  while (index < sql.length) {
    const protectedEnd = protectedSegmentEnd(sql, index);
    if (protectedEnd !== null) {
      output.push(sql.slice(index, protectedEnd));
      index = protectedEnd;
      continue;
    }
    const placeholder = /^\$(\d+)/.exec(sql.slice(index));
    if (placeholder) {
      mapPlaceholder(placeholder[1], params, mapped, used);
      output.push('?');
      index += placeholder[0].length;
      continue;
    }
    if (sql.startsWith('::', index)) {
      index = castEnd(sql, index);
      continue;
    }
    output.push(sql[index]);
    index += 1;
  }
  assertAllParamsUsed(params, used);
  return { sql: output.join(''), params: mapped };
}

function protectedSegmentEnd(sql: string, index: number): number | null {
  if ((sql[index] === 'E' || sql[index] === 'e') && sql[index + 1] === "'") {
    return quotedEnd(sql, index + 1, "'", true);
  }
  if ((sql[index] === 'U' || sql[index] === 'u') && sql[index + 1] === '&'
    && (sql[index + 2] === "'" || sql[index + 2] === '"')) {
    return quotedEnd(sql, index + 2, sql[index + 2], true);
  }
  if (sql[index] === "'") return quotedEnd(sql, index, "'");
  if (sql[index] === '"') return quotedEnd(sql, index, '"');
  if (sql.startsWith('--', index)) return lineCommentEnd(sql, index);
  if (sql.startsWith('/*', index)) return blockCommentEnd(sql, index);
  const delimiter = dollarQuoteDelimiter(sql, index);
  return delimiter ? dollarQuoteEnd(sql, index, delimiter) : null;
}

function quotedEnd(sql: string, start: number, quote: string, backslashEscapes = false): number {
  let index = start + 1;
  while (index < sql.length) {
    if (backslashEscapes && sql[index] === '\\') { index += 2; continue; }
    if (sql[index] !== quote) { index += 1; continue; }
    if (sql[index + 1] === quote) { index += 2; continue; }
    return index + 1;
  }
  throw new Error('SQLite SQL contains an unterminated quoted segment');
}

function castEnd(sql: string, start: number): number {
  const match = CAST_PATTERN.exec(sql.slice(start));
  if (!match) throw new Error('SQLite SQL contains an unsupported PostgreSQL cast');
  const end = start + match[0].length;
  if (/^\s*[.([]/.test(sql.slice(end))) {
    throw new Error('SQLite SQL contains an unsupported PostgreSQL cast');
  }
  return end;
}

function lineCommentEnd(sql: string, start: number): number {
  const end = sql.indexOf('\n', start + 2);
  return end === -1 ? sql.length : end + 1;
}

function blockCommentEnd(sql: string, start: number): number {
  let depth = 1;
  let index = start + 2;
  while (index < sql.length) {
    if (sql.startsWith('/*', index)) { depth += 1; index += 2; continue; }
    if (sql.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
      if (depth === 0) return index;
      continue;
    }
    index += 1;
  }
  throw new Error('SQLite SQL contains an unterminated block comment');
}

function dollarQuoteDelimiter(sql: string, index: number): string | null {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(index));
  return match?.[0] ?? null;
}

function dollarQuoteEnd(sql: string, start: number, delimiter: string): number {
  const end = sql.indexOf(delimiter, start + delimiter.length);
  if (end === -1) throw new Error('SQLite SQL contains an unterminated dollar-quoted segment');
  return end + delimiter.length;
}

function mapPlaceholder(
  digits: string,
  params: readonly unknown[],
  mapped: unknown[],
  used: Set<number>,
): void {
  const position = Number(digits);
  if (!Number.isSafeInteger(position) || position < 1 || position > params.length) {
    throw new Error(`SQLite SQL placeholder $${digits} has no matching parameter`);
  }
  used.add(position);
  mapped.push(params[position - 1]);
}

function assertAllParamsUsed(params: readonly unknown[], used: ReadonlySet<number>): void {
  for (let position = 1; position <= params.length; position += 1) {
    if (!used.has(position)) {
      throw new Error(`SQLite SQL parameter $${position} is not referenced by the statement`);
    }
  }
}

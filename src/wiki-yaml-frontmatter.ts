/**
 * Hand-rolled YAML frontmatter emitter for Obsidian wiki notes.
 *
 * The schema is flat: scalar keys plus one optional `tags` array. No nested
 * objects, no multi-line strings. This avoids adding a `yaml` dependency for
 * a tiny, well-constrained surface area.
 *
 * Quoting rules (YAML safe subset):
 *  - Strings containing `:`, `#`, leading/trailing whitespace, or that could
 *    be parsed as numbers/booleans/null are double-quoted.
 *  - Double quotes inside strings are escaped as `\"`.
 *  - Backslashes are escaped as `\\`.
 *  - Numbers, booleans, and null are emitted unquoted (YAML-native).
 */

export type FrontmatterValue = string | number | boolean | null | string[];

export type Frontmatter = Record<string, FrontmatterValue>;

/** True if a string must be double-quoted in YAML. */
function needsQuoting(value: string): boolean {
  if (value === '') return true;
  // Leading/trailing whitespace
  if (value !== value.trim()) return true;
  // Characters that change YAML parsing
  if (/[:#]/.test(value)) return true;
  // Could be parsed as a number, boolean, or null
  if (/^(true|false|null|yes|no|on|off)$/i.test(value)) return true;
  if (/^-?\d+(\.\d+)?$/.test(value)) return true;
  // ISO timestamps look like plain scalars but contain ':' — caught above
  return false;
}

/** Escape a string for inclusion inside double quotes. */
function escapeDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, ' ');
}

/** Emit a single scalar value as YAML. */
function emitScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (needsQuoting(value)) return `"${escapeDoubleQuoted(value)}"`;
  return value;
}

/** Emit a YAML array (block style, one item per line). */
function emitArray(items: string[]): string {
  if (items.length === 0) return '[]';
  return items.map(item => `  - ${emitScalar(item)}`).join('\n');
}

/**
 * Render frontmatter as a YAML document enclosed in `---` fences.
 * Returns the full fenced block including the opening and closing `---`.
 */
export function renderFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        lines.push(emitArray(value));
      }
    } else {
      lines.push(`${key}: ${emitScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

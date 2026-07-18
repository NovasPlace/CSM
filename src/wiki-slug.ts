/**
 * Slug and entity filename generation for Obsidian wiki export.
 *
 * Memory notes use stable immutable IDs: `mem-{id}.md`
 * Entity notes use slugged concept values + a short hash for collision resistance.
 */

import { createHash } from 'node:crypto';

/**
 * Slugify a string for use in filenames.
 * Lowercase, replace non-alphanumeric runs with `-`, trim leading/trailing dashes.
 */
export function slugify(s: string, maxLen = 80): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    || 'untitled';
}

/**
 * Generate a collision-resistant filename for an entity note.
 * Format: `{slug}-{4-char-hash}.md`
 *
 * The 4-char hash (first 4 hex chars of sha256) ensures that two different
 * concept values that slugify to the same string still get distinct files.
 */
export function entityFilename(conceptValue: string, maxSlugLen = 60): string {
  const slug = slugify(conceptValue, maxSlugLen);
  const hash = createHash('sha256').update(conceptValue).digest('hex').slice(0, 4);
  return `${slug}-${hash}.md`;
}

/**
 * Generate the stable filename for a memory note.
 * Always `mem-{id}.md` — immutable, no slug needed.
 */
export function memoryFilename(memoryId: number): string {
  return `mem-${memoryId}.md`;
}

/**
 * Generate the wikilink target for a memory note (without `.md` extension).
 * Obsidian wikilinks use the note basename, not the full path.
 */
export function memoryWikilink(memoryId: number): string {
  return `mem-${memoryId}`;
}

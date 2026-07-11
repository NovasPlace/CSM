import { isAbsolute, relative, resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Canonical project identity key.
 *
 * Resolves the path to an absolute form, dereferences junction/symlink
 * aliases via `realpathSync`, and case-folds on Windows so that
 * `C:\Repo`, `c:\repo`, and `C:\Link\To\Repo` all collapse to a single
 * key.  If `realpathSync` fails (e.g. the directory does not exist yet)
 * the pre-resolved absolute path is used as a fallback.
 *
 * Used by the auto-docs subsystem for:
 *   - `initializedProjects` Set membership
 *   - `pendingUpdatesByKey` Map keys
 *   - `flushTimersByKey` Map keys
 *   - in-flight initialization Promise chains
 */
export function projectKey(projectDir: string): string {
  let resolved = resolve(projectDir);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // Path may not exist yet (docs/ not created until init); use resolved form
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Resolve a non-root file path and confirm it remains within the project. */
export function resolveProjectFile(projectDir: string, filePath: string): string | null {
  const resolvedProjectDir = resolve(projectDir);
  const resolvedPath = resolve(resolvedProjectDir, filePath);
  const pathFromProject = relative(resolvedProjectDir, resolvedPath);
  const isContained = pathFromProject !== ''
    && !pathFromProject.startsWith(`..${sep}`)
    && pathFromProject !== '..'
    && !isAbsolute(pathFromProject);
  return isContained ? resolvedPath : null;
}

// SubconsciousWatcher - Auto-capture file changes as episodic memories
// Inspired by Agent Atlas subconscious.py
// Watches project directories and captures file edits

import * as fs from 'fs/promises';
import * as path from 'path';
import { MemoryManager } from './memory-manager.js';
import { autoDocumentChange } from './hooks/doc-analyzer.js';
import { getLogger } from './logger.js';

export interface FileChangeEvent {
  filePath: string;
  eventType: 'created' | 'modified' | 'deleted';
  timestamp: Date;
}

export class SubconsciousWatcher {
  private memoryManager: MemoryManager;
  private interval: number; // seconds
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchedPaths: Map<string, Date> = new Map(); // path -> last checked
  private initializedPaths = new Set<string>();
  private knownDirectories = new Set<string>();
  private scanInProgress = false;
  private currentSessionId: string | null = null;
  private filterBuildArtifacts: boolean;

  // Patterns for build artifact directories and files
  private static readonly BUILD_DIRS = new Set([
    'node_modules', 'dist', 'out', '.next', '.nuxt', 'build',
    '__pycache__', '.cache', '.parcel-cache', 'coverage',
    // Python virtualenvs and runtime sandboxes — descending into these can
    // corrupt the host (auto-docs once injected README.md into
    // jsonschema_specifications/schemas/, breaking jsonschema's import
    // and with it the MCP client that loads this very plugin).
    'venv', '.venv', 'env', '.env', 'Lib', 'lib', 'site-packages',
    '.tox', '.nox', 'target', '.git', '.hg', '.svn', '.gradle', '.mvn',
    // Host/OS state trees and generic caches — a session rooted at the user
    // home or inside a host cache must never auto-document these. Missing
    // entries let the watcher inject README.md into Hermes' own cache tree
    // (hermes/cache/delegation/live/...), the pip cache, and Unity/Unreal
    // generated trees (ArenaProject/Library/PackageCache), then echo every
    // injected README back into the DB as a [modified] README.md memory.
    'AppData', 'cache', 'logs', 'Logs', 'Temp', 'tmp',
    'Library', 'obj', 'bin', 'Saved', 'Intermediate', 'Binaries',
    'DerivedDataCache', 'pip', 'wheels', 'http-v2',
  ]);

  // Structural directories that should never get an auto-generated README
  private static readonly STRUCTURAL_DIRS = new Set([
    'src', 'test', 'tests', 'docs', 'plugins', 'migrations', 'scripts',
    // Game-engine source roots — Unity Assets/ProjectSettings/Packages and
    // Unreal Content/Source are code roots, not content to auto-document.
    'Assets', 'ProjectSettings', 'Packages', 'Content', 'Source',
  ]);

  // Substring of the README the watcher itself writes in handleNewDirectory.
  // Used to break the echo loop: a generated README must not become a
  // [modified] README.md episodic memory on the next scan.
  private static readonly AUTO_DOC_SIGNATURE =
    'This directory was detected by the Cross-Session Memory plugin';

  private static readonly BUILD_FILE_PATTERNS = [
    /\.map$/,        // source maps
    /\.min\.[jt]s$/, // minified files
    /\.chunk\.[jt]s$/, // chunk files
    /-[A-Za-z0-9_-]{8}\.[jt]s$/, // hashed filenames like foo-D7oLnXFd.js
    /-[A-Za-z0-9_-]{8}\.map$/,
  ];

  constructor(memoryManager: MemoryManager, interval: number = 30, filterBuildArtifacts: boolean = true) {
    this.memoryManager = memoryManager;
    this.interval = interval * 1000; // Convert to milliseconds
    this.filterBuildArtifacts = filterBuildArtifacts;
  }

  /**
   * Start the watcher
   */
  start(): void {
    if (this.timer) {
      getLogger().debug('SubconsciousWatcher already running');
      return;
    }

    getLogger().info(`SubconsciousWatcher starting (interval: ${this.interval / 1000}s)`);
    
    this.timer = setInterval(() => {
      if (this.scanInProgress) return;
      this.scanInProgress = true;
      this.watchFiles()
        .catch(error => {
          getLogger().error('SubconsciousWatcher watch failed', error instanceof Error ? error : undefined);
        })
        .finally(() => {
          this.scanInProgress = false;
        });
    }, this.interval);
  }

  /**
   * Stop the watcher
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      getLogger().info('SubconsciousWatcher stopped');
    }
  }

  /**
   * Add a path to watch
   *
   * Roots inside the host's own state trees are refused outright — a session
   * whose cwd lives under `AppData\Local\hermes` or `AppData\Local\pip` must
   * never be auto-documented (this is what let the watcher walk Hermes' own
   * venv and cache tree). Legit project roots never contain these segments.
   */
  watchPath(dirPath: string): void {
    const normalized = dirPath.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/appdata/local/hermes') || normalized.includes('/appdata/local/pip')) {
      getLogger().warn(`SubconsciousWatcher: refusing to watch host state path: ${dirPath}`);
      return;
    }
    this.watchedPaths.set(dirPath, new Date());
    getLogger().info(`SubconsciousWatcher watching: ${dirPath}`);
  }

  /**
   * Set current session
   */
  setSession(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Manually capture a file change
   */
  async captureFileChange(event: FileChangeEvent): Promise<void> {
    try {
      const content = await this.extractFileContent(event.filePath);
      const basename = path.basename(event.filePath).toLowerCase();
      // Break the echo loop: files this system itself writes must not be
      // re-captured as [modified] ... episodic memories on the next scan.
      // 1. README.md the auto-doc walker generated (AUTO_DOC_SIGNATURE).
      // 2. AGENTBOOK_STATE.md, rewritten by the tool_execute hook on every
      //    tool call (observed: 10k+ [modified] AGENTBOOK_STATE.md memories/week).
      const isSystemGenerated =
        (basename === 'readme.md' && content.includes(SubconsciousWatcher.AUTO_DOC_SIGNATURE)) ||
        basename === 'agentbook_state.md';
      if (isSystemGenerated) {
        return;
      }
      const symbols = this.extractSymbols(content, event.filePath);
      
      const memoryContent = this.formatFileChange(event, symbols);
      
      await this.memoryManager.saveMemory({
        content: memoryContent,
        type: 'episodic',
        importance: this.calculateImportance(event, symbols),
        emotion: 'neutral',
        source: 'subconscious',
        tags: ['file-change', event.eventType, this.getFileExtension(event.filePath)],
        metadata: {
          filePath: event.filePath,
          eventType: event.eventType,
          symbolCount: symbols.length,
          symbols: symbols.slice(0, 10), // First 10 symbols
        },
         sessionId: this.currentSessionId ?? undefined,
       });
     } catch (error) {
       getLogger().error('Failed to capture file change', error instanceof Error ? error : undefined);
     }
  }

  /**
   * Watch for file changes
   */
  private async watchFiles(): Promise<void> {
    for (const [dirPath, lastChecked] of this.watchedPaths) {
      try {
        const scanStartedAt = new Date();
        const captureNewDirectories = this.initializedPaths.has(dirPath);
        const changes = await this.detectChanges(dirPath, lastChecked, captureNewDirectories);
        
        for (const change of changes) {
          await this.captureFileChange(change);
        }
        
        // Preserve changes that land while a long scan is in progress for the next pass.
        this.watchedPaths.set(dirPath, scanStartedAt);
        this.initializedPaths.add(dirPath);
      } catch (error) {
        getLogger().error(`SubconsciousWatcher failed to watch ${dirPath}`, error instanceof Error ? error : undefined);
      }
     }
   }

  /**
   * Detect changes in a directory
   */
  private async detectChanges(
    dirPath: string,
    since: Date,
    captureNewDirectories: boolean,
  ): Promise<FileChangeEvent[]> {
    const changes: FileChangeEvent[] = [];
    
     try {
       await this.walkDirectory(dirPath, since, changes, dirPath, captureNewDirectories);
     } catch (error) {
       getLogger().error(`SubconsciousWatcher failed to walk ${dirPath}`, error instanceof Error ? error : undefined);
     }
     
     return changes;
  }

  /**
   * Walk directory recursively
   */
  private async walkDirectory(
    dirPath: string,
    since: Date,
    changes: FileChangeEvent[],
    projectRoot: string,
    captureNewDirectories: boolean,
  ): Promise<void> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        // Skip hidden files
        if (entry.name.startsWith('.')) {
          continue;
        }

        // Skip build artifact directories when filtering is enabled
        if (this.filterBuildArtifacts && entry.isDirectory()) {
          if (SubconsciousWatcher.BUILD_DIRS.has(entry.name)) {
            continue;
          }
        }
        
        if (entry.isDirectory()) {
          if (!this.knownDirectories.has(fullPath)) {
            // Seed existing directories during the first scan; only directories that
            // appear on later scans are eligible for automatic documentation.
            if (captureNewDirectories) {
              await this.handleNewDirectory(fullPath, projectRoot);
            }
            this.knownDirectories.add(fullPath);
          }
          await this.walkDirectory(fullPath, since, changes, projectRoot, captureNewDirectories);
        } else if (entry.isFile()) {
          // Skip build artifact files when filtering is enabled
          if (this.filterBuildArtifacts && this.isBuildArtifact(entry.name)) {
            continue;
          }

          try {
            const stats = await fs.stat(fullPath);
            
            if (stats.mtime > since) {
              changes.push({
                filePath: fullPath,
                eventType: 'modified',
                timestamp: stats.mtime,
              });
            }
          } catch {
            // File might have been deleted
          }
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  /**
   * Handle newly detected directory - auto-generate documentation
   */
  private async handleNewDirectory(dirPath: string, projectRoot: string): Promise<void> {
    try {
      // Skip structural directories and their subdirectories
      const dirName = path.basename(dirPath);
      if (SubconsciousWatcher.STRUCTURAL_DIRS.has(dirName)) {
        return;
      }
      // Also skip if any ancestor path segment is a structural directory
      const relative = path.relative(projectRoot, dirPath);
      const segments = relative.split(path.sep);
      if (segments.slice(0, -1).some(s => SubconsciousWatcher.STRUCTURAL_DIRS.has(s))) {
        return;
      }

      const readmePath = path.join(dirPath, 'README.md');

      // Check if README already exists
      try {
        await fs.access(readmePath);
        return; // README exists, skip
      } catch {
        // README doesn't exist, create it
      }
      // Resolve relative to projectRoot, not process.cwd(), so that
      // all auto-doc producers use one canonical project-relative identity.
      const resolvedDir = path.resolve(projectRoot, dirPath);
      const relativePath = path.relative(projectRoot, resolvedDir);
      // Reject paths that escape the project boundary
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        getLogger().warn(`[SubconsciousWatcher] Directory ${dirPath} escapes project root ${projectRoot}, skipping`);
        return;
      }
      
      const readmeContent = `# ${dirName}

Auto-generated documentation for \`${relativePath}\`

## Overview
This directory was detected by the Cross-Session Memory plugin's subconscious watcher.

## Contents
- Files and subdirectories will be documented here as they are added.

## Auto-Documentation
This README is maintained by the auto-docs system. When files are added to this directory, they will be automatically documented in the central SYSTEM_MAP.md and CHANGELOG_LIVE.md.

`;

      await fs.writeFile(readmePath, readmeContent, 'utf-8');
      
      // Trigger auto-docs to capture this new file.
      // Pass the project-relative path so SYSTEM_MAP.md entries are consistent
      // with normal file-change updates (which also use relative paths).
      const relativeReadmePath = path.join(relativePath, 'README.md');
      await autoDocumentChange(relativeReadmePath, 'write', undefined, readmeContent, projectRoot);

      getLogger().info(`Auto-generated README for new directory: ${relativePath}`);
    } catch (error) {
      getLogger().error(`[SubconsciousWatcher] Failed to auto-document new directory ${dirPath}`, error instanceof Error ? error : undefined);
    }
  }

  /**
   * Extract file content
   */
  private async extractFileContent(filePath: string): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // Limit to first 1000 lines
      const lines = content.split('\n').slice(0, 1000);
      return lines.join('\n');
    } catch {
      return '[Unable to read file]';
    }
  }

  /**
   * Extract symbols from content (simplified)
   */
  private extractSymbols(content: string, filePath: string): string[] {
    const symbols: string[] = [];
    const ext = path.extname(filePath).toLowerCase();
    
    // Simple regex patterns for different languages
    const patterns: RegExp[] = [];
    
    switch (ext) {
      case '.ts':
      case '.js':
      case '.tsx':
      case '.jsx':
        patterns.push(
          /(?:export\s+)?(?:async\s+)?function\s+(\w+)/g,
          /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=/g,
          /(?:export\s+)?class\s+(\w+)/g,
          /(?:export\s+)?interface\s+(\w+)/g,
          /(?:export\s+)?type\s+(\w+)/g
        );
        break;
      case '.py':
        patterns.push(
          /def\s+(\w+)/g,
          /class\s+(\w+)/g,
          /(\w+)\s*=/g
        );
        break;
      default:
        // Generic: look for common patterns
        patterns.push(
          /function\s+(\w+)/g,
          /class\s+(\w+)/g
        );
    }
    
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        if (match[1] && !symbols.includes(match[1])) {
          symbols.push(match[1]);
        }
      }
    }
    
    return symbols;
  }

  /**
   * Format file change as memory content
   */
  private formatFileChange(event: FileChangeEvent, symbols: string[]): string {
    const fileName = path.basename(event.filePath);
    const _ext = this.getFileExtension(event.filePath);
    
    let content = `[${event.eventType}] ${fileName}`;
    
    if (symbols.length > 0) {
      content += ` - Symbols: ${symbols.slice(0, 5).join(', ')}`;
      if (symbols.length > 5) {
        content += ` (+${symbols.length - 5} more)`;
      }
    }
    
    return content;
  }

  /**
   * Calculate importance based on file type and symbols
   */
  private calculateImportance(event: FileChangeEvent, symbols: string[]): number {
    let importance = 0.3; // Base importance
    
    // Increase importance for certain file types
    const ext = this.getFileExtension(event.filePath);
    if (['.ts', '.js', '.py', '.rs', '.go'].includes(ext)) {
      importance += 0.1;
    }
    
    // Increase importance for more symbols
    if (symbols.length > 5) {
      importance += 0.1;
    }
    if (symbols.length > 10) {
      importance += 0.1;
    }
    
    // Decrease importance for config files
    if (['.json', '.yaml', '.yml', '.toml', '.env'].includes(ext)) {
      importance -= 0.1;
    }
    
    return Math.max(0, Math.min(1, importance));
  }

  /**
   * Get file extension
   */
  private getFileExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase();
  }

  /**
   * Check if a filename matches build artifact patterns
   */
  private isBuildArtifact(filename: string): boolean {
    return SubconsciousWatcher.BUILD_FILE_PATTERNS.some(pattern => pattern.test(filename));
  }
}

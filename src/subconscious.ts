// SubconsciousWatcher - Auto-capture file changes as episodic memories
// Inspired by Agent Atlas subconscious.py
// Watches project directories and captures file edits

import * as fs from 'fs/promises';
import * as path from 'path';
import { MemoryManager } from './memory-manager.js';
import { MemorySaveOptions } from './types.js';
import { autoDocumentChange } from './hooks/doc-analyzer.js';

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
  private currentSessionId: string | null = null;
  private filterBuildArtifacts: boolean;

  // Patterns for build artifact directories and files
  private static readonly BUILD_DIRS = new Set([
    'node_modules', 'dist', 'out', '.next', '.nuxt', 'build',
    '__pycache__', '.cache', '.parcel-cache', 'coverage',
  ]);

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
      console.log('[SubconsciousWatcher] Already running');
      return;
    }

    console.log(`[SubconsciousWatcher] Starting (interval: ${this.interval / 1000}s)`);
    
    this.timer = setInterval(() => {
      this.watchFiles().catch(error => {
        console.error('[SubconsciousWatcher] Watch failed:', error);
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
      console.log('[SubconsciousWatcher] Stopped');
    }
  }

  /**
   * Add a path to watch
   */
  watchPath(dirPath: string): void {
    this.watchedPaths.set(dirPath, new Date());
    console.log(`[SubconsciousWatcher] Watching: ${dirPath}`);
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
      console.error('[SubconsciousWatcher] Failed to capture file change:', error);
    }
  }

  /**
   * Watch for file changes
   */
  private async watchFiles(): Promise<void> {
    for (const [dirPath, lastChecked] of this.watchedPaths) {
      try {
        const changes = await this.detectChanges(dirPath, lastChecked);
        
        for (const change of changes) {
          await this.captureFileChange(change);
        }
        
        // Update last checked time
        this.watchedPaths.set(dirPath, new Date());
      } catch (error) {
        console.error(`[SubconsciousWatcher] Failed to watch ${dirPath}:`, error);
      }
    }
  }

  /**
   * Detect changes in a directory
   */
  private async detectChanges(dirPath: string, since: Date): Promise<FileChangeEvent[]> {
    const changes: FileChangeEvent[] = [];
    
    try {
      await this.walkDirectory(dirPath, since, changes);
    } catch (error) {
      console.error(`[SubconsciousWatcher] Failed to walk ${dirPath}:`, error);
    }
    
    return changes;
  }

  /**
   * Walk directory recursively
   */
  private async walkDirectory(
    dirPath: string,
    since: Date,
    changes: FileChangeEvent[]
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
          // Check if this is a newly created directory (no previous record)
          const dirKey = `dir:${fullPath}`;
          const dirLastChecked = this.watchedPaths.get(dirKey);
          if (!dirLastChecked) {
            // New directory detected - auto-generate docs
            await this.handleNewDirectory(fullPath);
            this.watchedPaths.set(dirKey, new Date());
          }
          await this.walkDirectory(fullPath, since, changes);
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
  private async handleNewDirectory(dirPath: string): Promise<void> {
    try {
      const readmePath = path.join(dirPath, 'README.md');
      
      // Check if README already exists
      try {
        await fs.access(readmePath);
        return; // README exists, skip
      } catch {
        // README doesn't exist, create it
      }

      const dirName = path.basename(dirPath);
      const relativePath = path.relative(process.cwd(), dirPath);
      
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
      
      // Trigger auto-docs to capture this new file
      await autoDocumentChange(readmePath, 'write', undefined, readmeContent);
      
      console.log(`[SubconsciousWatcher] Auto-generated README for new directory: ${relativePath}`);
    } catch (error) {
      console.error(`[SubconsciousWatcher] Failed to auto-document new directory ${dirPath}:`, error);
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
    const ext = this.getFileExtension(event.filePath);
    
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

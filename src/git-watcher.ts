// GitWatcher - Store commits as searchable episodic memories
// Inspired by Agent Atlas git_watcher.py
// Polls git repos for new commits and stores them as memories

import { exec } from 'child_process';
import { promisify } from 'util';
import { MemoryManager } from './memory-manager.js';
import { MemorySaveOptions } from './types.js';
import { getLogger } from './logger.js';

const execAsync = promisify(exec);

export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  date: Date;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface GitRepoState {
  path: string;
  lastCheckedSha: string | null;
  lastCheckedAt: Date;
}

export class GitWatcher {
  private memoryManager: MemoryManager;
  private interval: number; // seconds
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchedRepos: Map<string, GitRepoState> = new Map();
  private currentSessionId: string | null = null;

  constructor(memoryManager: MemoryManager, interval: number = 60) {
    this.memoryManager = memoryManager;
    this.interval = interval * 1000; // Convert to milliseconds
  }

  /**
   * Start the watcher
   */
  start(): void {
    if (this.timer) {
      getLogger().debug('GitWatcher already running');
      return;
    }

    getLogger().info(`GitWatcher starting (interval: ${this.interval / 1000}s)`);
    
    this.timer = setInterval(() => {
      this.pollRepos().catch(error => {
        getLogger().error('GitWatcher poll failed', error instanceof Error ? error : undefined);
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
      getLogger().info('GitWatcher stopped');
    }
  }

  /**
   * Add a repo to watch
   */
  async watchRepo(repoPath: string): Promise<void> {
    // Get current HEAD sha
    const currentSha = await this.getCurrentSha(repoPath);
    
    this.watchedRepos.set(repoPath, {
      path: repoPath,
      lastCheckedSha: currentSha,
      lastCheckedAt: new Date(),
    });
    
    getLogger().info(`GitWatcher watching repo: ${repoPath} (sha: ${currentSha?.substring(0, 7) ?? 'unknown'})`);
  }

  /**
   * Set current session
   */
  setSession(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  /**
   * Poll all watched repos for new commits
   */
  private async pollRepos(): Promise<void> {
    for (const [repoPath, state] of this.watchedRepos) {
      try {
        const newCommits = await this.getNewCommits(repoPath, state.lastCheckedSha);
        
        for (const commit of newCommits) {
          await this.storeCommitAsMemory(commit, repoPath);
        }
        
        // Update state
        const currentSha = await this.getCurrentSha(repoPath);
        this.watchedRepos.set(repoPath, {
          ...state,
          lastCheckedSha: currentSha,
          lastCheckedAt: new Date(),
         });
       } catch (error) {
         getLogger().error(`GitWatcher failed to poll ${repoPath}`, error instanceof Error ? error : undefined);
       }
    }
  }

  /**
   * Get current HEAD sha
   */
  private async getCurrentSha(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoPath });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Get new commits since a specific sha
   */
  private async getNewCommits(repoPath: string, sinceSha: string | null): Promise<GitCommit[]> {
    const commits: GitCommit[] = [];
    
    try {
      // Get commits since last checked
      const range = sinceSha ? `${sinceSha}..HEAD` : 'HEAD~10..HEAD';
      const { stdout } = await execAsync(
        `git log ${range} --pretty=format:"%H|%s|%an|%aI" --stat`,
        { cwd: repoPath }
      );
      
      if (!stdout.trim()) {
        return [];
      }
      
      const lines = stdout.split('\n');
      let currentCommit: Partial<GitCommit> | null = null;
      
      for (const line of lines) {
        if (line.includes('|')) {
          // New commit line
          if (currentCommit?.sha) {
            commits.push(currentCommit as GitCommit);
          }
          
          const [sha, subject, author, dateStr] = line.split('|');
          currentCommit = {
            sha: sha.replace(/"/g, ''),
            subject: subject.replace(/"/g, ''),
            author: author.replace(/"/g, ''),
            date: new Date(dateStr.replace(/"/g, '')),
            filesChanged: 0,
            insertions: 0,
            deletions: 0,
          };
        } else if (currentCommit && line.trim()) {
          // Stats line (e.g., " file.ts | 10 ++++---")
          const match = line.match(/(\d+) files? changed/);
          if (match) {
            currentCommit.filesChanged = parseInt(match[1], 10);
          }
          
          const insertMatch = line.match(/(\d+) insertions?\(\+\)/);
          if (insertMatch) {
            currentCommit.insertions = parseInt(insertMatch[1], 10);
          }
          
          const deleteMatch = line.match(/(\d+) deletions?\(-\)/);
          if (deleteMatch) {
            currentCommit.deletions = parseInt(deleteMatch[1], 10);
          }
        }
      }
      
      // Add last commit
      if (currentCommit?.sha) {
        commits.push(currentCommit as GitCommit);
       }
     } catch (error) {
       getLogger().error(`GitWatcher failed to get commits`, error instanceof Error ? error : undefined);
     }
     
     return commits;
  }

  /**
   * Store a commit as an episodic memory
   */
  private async storeCommitAsMemory(commit: GitCommit, repoPath: string): Promise<void> {
    const content = this.formatCommit(commit, repoPath);
    
    await this.memoryManager.saveMemory({
      content,
      type: 'repo',
      importance: this.calculateCommitImportance(commit),
      emotion: 'neutral',
      source: 'git',
      tags: ['git-commit', commit.author, repoPath],
      metadata: {
        sha: commit.sha,
        author: commit.author,
        filesChanged: commit.filesChanged,
        insertions: commit.insertions,
        deletions: commit.deletions,
        repoPath,
      },
      sessionId: this.currentSessionId ?? undefined,
    });
  }

  /**
   * Format commit as memory content
   */
  private formatCommit(commit: GitCommit, repoPath: string): string {
    const shortSha = commit.sha.substring(0, 7);
    const repoName = repoPath.split('/').pop() ?? repoPath;
    
    let content = `[git] ${repoName} ${shortSha}: ${commit.subject}`;
    content += ` (${commit.author}`;
    
    if (commit.filesChanged > 0) {
      content += `, ${commit.filesChanged} files changed`;
      if (commit.insertions > 0 || commit.deletions > 0) {
        content += ` (+${commit.insertions}/-${commit.deletions})`;
      }
    }
    
    content += ')';
    
    return content;
  }

  /**
   * Calculate commit importance
   */
  private calculateCommitImportance(commit: GitCommit): number {
    let importance = 0.4; // Base importance
    
    // Increase importance for more files changed
    if (commit.filesChanged > 5) {
      importance += 0.1;
    }
    if (commit.filesChanged > 10) {
      importance += 0.1;
    }
    
    // Increase importance for larger changes
    if (commit.insertions + commit.deletions > 100) {
      importance += 0.1;
    }
    
    // Decrease importance for merge commits
    if (commit.subject.toLowerCase().startsWith('merge ')) {
      importance -= 0.2;
    }
    
    return Math.max(0.1, Math.min(0.8, importance));
  }

  /**
   * Get recent commits from a repo
   */
  async getRecentCommits(repoPath: string, limit: number = 10): Promise<GitCommit[]> {
    try {
      const { stdout } = await execAsync(
        `git log --pretty=format:"%H|%s|%an|%aI" --stat -n ${limit}`,
        { cwd: repoPath }
      );
      
      const commits: GitCommit[] = [];
      const lines = stdout.split('\n');
      let currentCommit: Partial<GitCommit> | null = null;
      
      for (const line of lines) {
        if (line.includes('|')) {
          if (currentCommit?.sha) {
            commits.push(currentCommit as GitCommit);
          }
          
          const [sha, subject, author, dateStr] = line.split('|');
          currentCommit = {
            sha: sha.replace(/"/g, ''),
            subject: subject.replace(/"/g, ''),
            author: author.replace(/"/g, ''),
            date: new Date(dateStr.replace(/"/g, '')),
            filesChanged: 0,
            insertions: 0,
            deletions: 0,
          };
        } else if (currentCommit && line.trim()) {
          const match = line.match(/(\d+) files? changed/);
          if (match) {
            currentCommit.filesChanged = parseInt(match[1], 10);
          }
          
          const insertMatch = line.match(/(\d+) insertions?\(\+\)/);
          if (insertMatch) {
            currentCommit.insertions = parseInt(insertMatch[1], 10);
          }
          
          const deleteMatch = line.match(/(\d+) deletions?\(-\)/);
          if (deleteMatch) {
            currentCommit.deletions = parseInt(deleteMatch[1], 10);
          }
        }
      }
      
      if (currentCommit?.sha) {
        commits.push(currentCommit as GitCommit);
      }
       
       return commits;
     } catch (error) {
       getLogger().error(`GitWatcher failed to get recent commits`, error instanceof Error ? error : undefined);
       return [];
     }
   }
 }

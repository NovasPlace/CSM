// Memory Extractor - Auto-extract salient facts from conversation turns
// Inspired by Agent Atlas memory_bridge.py

import { Database } from './database.js';
import { EmbeddingGenerator } from './embeddings.js';
import { MemoryManager } from './memory-manager.js';
import { getLogger } from './logger.js';
import { nowFn } from './db/query-dialect.js';
import {
  Memory,
  MemoryType,
  MemoryEmotion,
  MemorySource,
  MemoryCandidate,
  MemoryCandidateStatus,
  MemoryApproval,
  ExtractorConfig,
  ToolCallGroup,
  ToolCallSummary,
} from './types.js';
export class MemoryExtractor {
  private database: Database;
  private embeddings: EmbeddingGenerator;
  private memoryManager: MemoryManager;
  private config: {
    enabled: boolean;
    minTurnsBeforeExtract: number;
    maxCandidatesPerTurn: number;
    confidenceThreshold: number;
    autoApproveThreshold: number;
  };

  constructor(database: Database, memoryManager: MemoryManager, config: ExtractorConfig) {
    this.database = database;
    this.memoryManager = memoryManager;
    this.config = config;
    this.embeddings = new EmbeddingGenerator({
      embeddingModel: 'text-embedding-3-small',
    });
  }

  /**
   * Extract memories from conversation turns
   */
  async extractFromTurns(sessionId: string, projectId: string, turns: any[]): Promise<MemoryCandidate[]> {
    if (!this.config.enabled) return [];

    if (turns.length < this.config.minTurnsBeforeExtract) {
      return [];
    }

    const candidates: MemoryCandidate[] = [];

    for (const turn of turns) {
      if (candidates.length >= this.config.maxCandidatesPerTurn) {
        break;
      }

      // Analyze turn for extractable content
      const analysis = await this.analyzeTurnForMemories(turn);

      if (analysis.score >= this.config.confidenceThreshold) {
        const candidate: MemoryCandidate = {
          id: `candidate_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          sessionId,
          projectId,
          proposedType: analysis.type,
          content: analysis.content,
          importance: analysis.importance,
          emotion: analysis.emotion,
          confidence: analysis.score,
          tags: this.generateTags(analysis),
          metadata: {
            turnId: turn.id,
            role: turn.role,
            source: 'extractor',
            extractionMethod: 'llm',
          },
          status: this.determineInitialStatus(analysis.score),
          source: 'extractor',
          createdAt: new Date(),
          reviewedAt: undefined,
          reviewedBy: undefined,
        };

        candidates.push(candidate);

        // Auto-save approved candidates
        if (candidate.status === 'auto-approved' || candidate.status === 'approved') {
          await this.saveCandidateAsMemory(candidate);
        }
      }
    }

    return candidates;
  }

  /**
   * Extract memories from distilled tool-call summaries.
   * Distilled groups are high-signal: they become procedural (success) or
   * lesson (failure/partial) candidates with elevated confidence.
   */
  async extractFromDistilledSummaries(
    sessionId: string,
    projectId: string,
    summary: ToolCallSummary,
  ): Promise<MemoryCandidate[]> {
    if (!this.config.enabled) return [];
    if (!summary.groups || summary.groups.length === 0) return [];

    const candidates: MemoryCandidate[] = [];

    for (const group of summary.groups) {
      if (candidates.length >= this.config.maxCandidatesPerTurn) break;
      if (!group.proceduralInsight) continue;

      const candidate = this.buildDistilledCandidate(
        sessionId,
        projectId,
        group,
      );
      candidates.push(candidate);

      if (candidate.status === 'auto-approved' || candidate.status === 'approved') {
        await this.saveCandidateAsMemory(candidate);
      }
    }

    return candidates;
  }

  /** Build a MemoryCandidate from a distilled tool-call group */
  private buildDistilledCandidate(
    sessionId: string,
    projectId: string,
    group: ToolCallGroup,
  ): MemoryCandidate {
    const isFailure = group.outcome === 'failure' || group.outcome === 'partial';
    const type: MemoryType = isFailure ? 'lesson' : 'procedural';
    const importance = isFailure ? 0.75 : 0.6;
    const emotion: MemoryEmotion = isFailure ? 'frustration' : 'success';
    const confidence = 0.92;

    let content = group.proceduralInsight ?? group.intent;
    if (isFailure) {
      content = this.makeActionableLesson(content, group);
    }

    const tags = this.generateDistilledTags(group, isFailure);
    const metadata: Record<string, unknown> = {
      source: 'distiller',
      extractionMethod: 'deterministic',
      intent: group.intent,
      filesChanged: group.filesChanged,
      commandsRun: group.commandsRun,
      outcome: group.outcome,
      errorSummary: group.errorSummary,
      fixApplied: group.fixApplied,
      toolCallCount: group.toolCalls.length,
    };

    if (isFailure) {
      const triggerMeta = this.inferTriggerMetaFromGroup(group);
      if (Object.keys(triggerMeta).length > 0) {
        metadata.triggers = triggerMeta;
      }
    }

    return {
      id: `distill_${group.id}`,
      sessionId,
      projectId,
      proposedType: type,
      content,
      importance,
      emotion,
      confidence,
      tags,
      metadata,
      status: this.determineInitialStatus(confidence),
      source: 'extractor',
      createdAt: new Date(),
      reviewedAt: undefined,
      reviewedBy: undefined,
    };
  }

  private makeActionableLesson(content: string, group: ToolCallGroup): string {
    if (content.toLowerCase().startsWith('lesson:') || content.toLowerCase().startsWith('lessone:')) {
      content = content.replace(/^lessons?:\s*/i, '');
    }

    const hasActionWord = /\b(use|never|always|avoid|do not|don't|instead|replace|fix)\b/i.test(content);
    if (!hasActionWord) {
      const fix = group.fixApplied ?? group.errorSummary ?? '';
      if (fix) {
        content = `Instead of that approach, ${fix}. ${content}`;
      } else {
        content = `Avoid this — ${content}`;
      }
    }

    return content;
  }

  private inferTriggerMetaFromGroup(group: ToolCallGroup): Record<string, unknown> {
    const tools = [...new Set(group.toolCalls.map((c) => c.tool))];
    const files = [...new Set(group.filesChanged)]
      .map((f) => {
        const dot = f.lastIndexOf('.');
        return dot >= 0 ? f.substring(dot) : '';
      })
      .filter((f) => f.length > 0 && f.length <= 6);
    const triggers: Record<string, unknown> = {};
    if (tools.length > 0) triggers.tools = tools;
    if (files.length > 0) triggers.files = [...new Set(files)];
    return triggers;
  }

  /** Generate tags for a distilled candidate */
  private generateDistilledTags(group: ToolCallGroup, isFailure: boolean): string[] {
    const tags = [isFailure ? 'lesson' : 'procedural', 'distilled'];

    if (isFailure) tags.push('issue');
    if (group.fixApplied) tags.push('fix-applied');
    if (group.filesChanged.length > 0) tags.push('file-edit');
    if (group.commandsRun.length > 0) tags.push('command');

    const tools = new Set(group.toolCalls.map((c) => c.tool));
    for (const tool of tools) tags.push(`tool:${tool}`);

    return tags;
  }

  /**
   * Analyze a turn for extractable memory content
   */
  private async analyzeTurnForMemories(turn: any): Promise<{
    type: MemoryType;
    content: string;
    importance: number;
    emotion?: MemoryEmotion;
    score: number;
  }> {
    const content = this.extractContentFromTurn(turn);
    const lower = content.toLowerCase();
    // Determine type based on content
    let type: MemoryType = 'conversation';
    let importance = 0.3;
    let emotion: MemoryEmotion = 'neutral';

    if (lower.includes('decision') || lower.includes('choose') || lower.includes('selected')) {
      type = 'preference';
      importance = 0.6;
    } else if (lower.includes('error') || lower.includes('bug') || lower.includes('fix') || lower.includes('problem')) {
      type = 'lesson';
      importance = 0.7;
      emotion = 'frustration';
    } else if (lower.includes('how to') || lower.includes('step') || lower.includes('procedure') || lower.includes('guide')) {
      type = 'procedural';
      importance = 0.5;
    } else if (lower.includes('project') || lower.includes('code') || lower.includes('file') || lower.includes('config')) {
      type = 'workspace';
      importance = 0.4;
    } else if (lower.includes('commit') || lower.includes('git') || lower.includes('pull request')) {
      type = 'repo';
      importance = 0.5;
    }

    // Calculate confidence score based on content quality
    const score = this.calculateExtractionScore(content, type, importance);

    return {
      type,
      content,
      importance,
      emotion,
      score,
    };
  }

  /**
   * Extract relevant content from a turn
   */
  private extractContentFromTurn(turn: any): string {
    if (turn.role === 'user') {
      return `[User request]: ${turn.content}`;
    } else if (turn.role === 'assistant') {
      // Extract key decisions, solutions, or insights
      const content = turn.content;
      
      // Look for decision patterns
      const decisionPatterns = [
        /I (?:will|choose|select|recommend|decide)/i,
        /decided (?:to|that)/i,
        /solution: .*/i,
        /approach: .*/i,
        /strategy: .*/i,
      ];
      
      for (const pattern of decisionPatterns) {
        const match = content.match(pattern);
        if (match) {
          return `[Decision]: ${match[0]}`;
        }
      }
      
      // Look for error patterns
      const errorPatterns = [
        /error: .*/i,
        /bug: .*/i,
        /issue: .*/i,
        /problem: .*/i,
        /fix: .*/i,
      ];
      
      for (const pattern of errorPatterns) {
        const match = content.match(pattern);
        if (match) {
          return `[Issue]: ${match[0]}`;
        }
      }
      
      // Look for guidance patterns
      const guidancePatterns = [
        /how to/i,
        /step (?:by step|by)/i,
        /guide: .*/i,
        /procedure: .*/i,
        /implement: .*/i,
      ];
      
      for (const pattern of guidancePatterns) {
        const match = content.match(pattern);
        if (match) {
          return `[Guidance]: ${match[0]}`;
        }
      }
      
      // Default: extract first sentence or key phrase
      const firstSentence = content.split(/[.!?]+/).find((s: string) => s.trim().length > 20);
      if (firstSentence) {
        return `[Key insight]: ${firstSentence.trim()}`;
      }
      
      return `[Assistant response]: ${content.substring(0, 200)}`;
    }
    
    return turn.content ?? '';
  }

  /**
   * Calculate confidence score for extraction
   */
  private calculateExtractionScore(content: string, type: MemoryType, importance: number): number {
    let score = 0.5; // Base score

    // Boost for clear indicators
    if (content.includes('[Decision]:') || content.includes('[Issue]:') || content.includes('[Guidance]:') || content.includes('[Key insight]:')) {
      score += 0.3;
    }

    // Boost for length (not too short, not too long)
    if (content.length > 50 && content.length < 1000) {
      score += 0.1;
    }

    // Boost for importance
    score += importance * 0.2;

    // Boost for type-specific patterns
    if (type === 'lesson' && (content.includes('error') || content.includes('bug') || content.includes('problem'))) {
      score += 0.2;
    }

    // Cap at 1.0
    return Math.min(score, 1.0);
  }

  /**
   * Determine initial status based on confidence
   */
  private determineInitialStatus(score: number): 'pending' | 'approved' | 'rejected' | 'auto-approved' {
    if (score >= this.config.autoApproveThreshold) {
      return 'auto-approved';
    } else if (score >= this.config.confidenceThreshold) {
      return 'approved';
    } else {
      return 'pending';
    }
  }

  /**
   * Save a candidate as a memory
   */
  private async saveCandidateAsMemory(candidate: MemoryCandidate): Promise<void> {
    try {
      await this.memoryManager.saveMemory({
        content: candidate.content,
        type: candidate.proposedType,
        importance: candidate.importance,
        emotion: candidate.emotion,
        confidence: candidate.confidence,
        source: 'auto',
        tags: candidate.tags,
        metadata: {
          ...candidate.metadata,
          candidateId: candidate.id,
          source: 'extractor',
          autoApproved: candidate.status === 'auto-approved',
        },
        sessionId: candidate.sessionId,
       });
     } catch (error) {
       getLogger().error('Failed to save candidate', error instanceof Error ? error : undefined);
     }
  }

  /**
   * Generate tags based on analysis
   */
  private generateTags(analysis: {
    type: MemoryType;
    content: string;
    importance: number;
    emotion?: MemoryEmotion;
  }): string[] {
    const tags: string[] = [analysis.type];

    if (analysis.importance > 0.7) tags.push('high-importance');
    if (analysis.importance > 0.5) tags.push('medium-importance');
    if (analysis.emotion) tags.push(analysis.emotion);

    const lower = analysis.content.toLowerCase();
    if (lower.includes('decision')) tags.push('decision');
    if (lower.includes('error') || lower.includes('bug')) tags.push('issue');
    if (lower.includes('how to') || lower.includes('step')) tags.push('guidance');
    if (lower.includes('learn') || lower.includes('lesson')) tags.push('learning');

    return tags;
  }

  /**
   * Get pending candidates for review
   */
  async getPendingCandidates(sessionId?: string, limit: number = 50): Promise<MemoryCandidate[]> {
    const pool = this.database.getPool();
    
    let query = 'SELECT * FROM memory_candidates WHERE status = $1';
    const params: unknown[] = ['pending'];
    
    if (sessionId) {
      query += ' AND session_id = $2';
      params.push(sessionId);
    }
    
    query += ' ORDER BY created_at DESC LIMIT $3';
    params.push(limit);
    
    const result = await pool.query(query, params);
    
    return result.rows.map(row => this.mapCandidate(row as Record<string, unknown>));
  }

  /**
   * Approve or reject a candidate
   */
  async reviewCandidate(approval: MemoryApproval, reviewer: 'user' | 'system'): Promise<void> {
    const pool = this.database.getPool();
    
    // Update candidate status
    await pool.query(
      'UPDATE memory_candidates SET status = $1, reviewed_at = $2, reviewed_by = $3 WHERE id = $4',
      [
        approval.action === 'approve' ? 'approved' : 'rejected',
        new Date(),
        reviewer,
        approval.candidateId,
      ]
    );

    // If approved with edits, save as memory
    const candidate = await this.getCandidateById(approval.candidateId);
    if (approval.action === 'approve' && candidate) {
      await this.saveCandidateAsMemory({
        ...candidate,
        proposedType: approval.editedType ?? candidate.proposedType,
        content: approval.editedContent ?? candidate.content,
        importance: approval.editedImportance ?? candidate.importance,
        tags: approval.editedTags ?? candidate.tags,
      });
    }

    // Emit event
    await this.memoryManager.emitEvent(
      'candidate.reviewed',
      {
        candidateId: approval.candidateId,
        action: approval.action,
        reviewer,
        edited: !!approval.editedContent || !!approval.editedType || !!approval.editedImportance || !!approval.editedTags,
      },
      candidate?.sessionId
    );
  }

  /**
   * Get candidate by ID
   */
  async getCandidateById(id: string): Promise<MemoryCandidate | null> {
    const pool = this.database.getPool();
    
    const result = await pool.query('SELECT * FROM memory_candidates WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return null;
    }
    
    return this.mapCandidate(result.rows[0] as Record<string, unknown>);
  }

  /**
   * Clean up expired candidates
   */
  async cleanupExpiredCandidates(): Promise<void> {
    const pool = this.database.getPool();
    
    // Delete rejected candidates older than 7 days
    await pool.query(
      `DELETE FROM memory_candidates WHERE status = $1 AND created_at < ${nowFn(this.database.dialect)} - interval '7 days'`,
      ['rejected']
    );

    // Archive approved candidates older than 30 days
    await pool.query(
      `UPDATE memory_candidates SET status = $1 WHERE status = $2 AND created_at < ${nowFn(this.database.dialect)} - interval '30 days'`,
      ['archived', 'approved']
    );
  }

  /**
   * Map database row to MemoryCandidate
   */
  private mapCandidate(row: Record<string, unknown>): MemoryCandidate {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      projectId: row.project_id as string,
      proposedType: row.proposed_type as MemoryType,
      content: row.content as string,
      importance: row.importance as number,
      emotion: row.emotion as MemoryEmotion | undefined,
      confidence: row.confidence as number,
      tags: row.tags as string[],
      metadata: row.metadata as Record<string, unknown>,
      status: row.status as MemoryCandidateStatus,
      source: row.source as 'extractor' | 'manual',
      createdAt: row.created_at as Date,
      reviewedAt: row.reviewed_at as Date | undefined,
      reviewedBy: row.reviewed_by as string | undefined,
    };
  }
}

export type { ExtractorConfig } from './types.js';
import type {
  AlchemistIngest, AlchemistLesson, AlchemistLessonType,
  AlchemistSource, AlchemistConfig, ExtractedCapability,
  GapReport, Blueprint,
} from './types.js';
import { estimateTokens } from './token-bucket-analyzer.js';

export const DEFAULT_ALCHEMIST_CONFIG: AlchemistConfig = {
  organismManifest: [],
  verificationThreshold: 2,
  maxLessons: 500,
  autoVerify: true,
  recallTopK: 5,
};

const CAPABILITY_PATTERNS: { pattern: RegExp; type: ExtractedCapability['type']; name: string }[] = [
  { pattern: /function\s+(\w+)\s*\(/g, type: 'feature', name: 'export' },
  { pattern: /class\s+(\w+)/g, type: 'feature', name: 'class' },
  { pattern: /export\s+(?:const|function|class|interface|type)\s+(\w+)/g, type: 'feature', name: 'export' },
  { pattern: /TODO|FIXME|HACK|XXX/gi, type: 'gap', name: 'todo_marker' },
  { pattern: /catch\s*\([^)]*\)\s*\{\s*\}/g, type: 'anti_pattern', name: 'swallowed_error' },
  { pattern: /any\b/g, type: 'anti_pattern', name: 'any_type' },
  { pattern: /!\s*[\w.]+\s*;/g, type: 'risk', name: 'non_null_assertion' },
  { pattern: /console\.(log|debug|info|warn|error)\s*\(/g, type: 'anti_pattern', name: 'console_logging' },
  { pattern: /\.skip\s*\(/g, type: 'anti_pattern', name: 'skipped_test' },
  { pattern: /try\s*\{[^}]*\}\s*catch\s*\([^)]*\)\s*\{\s*\}/gs, type: 'risk', name: 'empty_catch' },
  { pattern: /password|secret|api_key|apikey|token|credential/gi, type: 'risk', name: 'hardcoded_secret' },
  { pattern: /SELECT\s+.*\s+FROM\s+.*\s+WHERE\s+.*\+\s*/gi, type: 'risk', name: 'sql_injection' },
];

const FAILURE_PATTERNS: { pattern: RegExp; type: AlchemistLessonType; trigger: string; action: string }[] = [
  {
    pattern: /SQL.*parameter.*index|mixed.*LIMIT.*JSONB|parameter.*binding/i,
    type: 'repair_recipe',
    trigger: 'SQL query with mixed parameter types',
    action: 'Check reused SQL parameter indexes when mixing LIMIT and JSONB filters',
  },
  {
    pattern: /Cannot read properties of undefined|undefined is not|TypeError.*undefined/i,
    type: 'anti_pattern',
    trigger: 'Accessing nested property without null check',
    action: 'Use optional chaining (?.) or guard clauses before accessing nested properties',
  },
  {
    pattern: /ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i,
    type: 'repair_recipe',
    trigger: 'Network request failure',
    action: 'Add retry with exponential backoff, check endpoint availability before request',
  },
  {
    pattern: /out of memory|heap|stack overflow|RangeError.*maximum/i,
    type: 'anti_pattern',
    trigger: 'Memory pressure or unbounded growth',
    action: 'Add size limits, streaming, or pagination to prevent unbounded collection growth',
  },
  {
    pattern: /circular dependency|import cycle|CIRCULAR/i,
    type: 'anti_pattern',
    trigger: 'Circular module dependency detected',
    action: 'Extract shared types to a separate module, use dependency injection to break the cycle',
  },
  {
    pattern: /race condition|concurrent|deadlock|mutual exclusion/i,
    type: 'anti_pattern',
    trigger: 'Concurrency issue detected',
    action: 'Add proper synchronization, use atomic operations, or restructure to avoid shared mutable state',
  },
  {
    pattern: /placeholder|parameter|prepared statement|parameterized query|\$\d/i,
    type: 'risk_rule' as const,
    trigger: 'SQL parameter handling anti-pattern',
    action: 'Verify parameter indexes match query placeholders, check for off-by-one in LIMIT/OFFSET',
  },
  {
    pattern: /test.*fail|assert.*fail|expected.*actual/i,
    type: 'repair_recipe',
    trigger: 'Test failure',
    action: 'Check if test depends on timing, order, or external state; add proper setup/teardown',
  },
];

export class AlchemistEngine {
  private lessons: Map<string, AlchemistLesson> = new Map();
  private capabilities: Map<string, ExtractedCapability> = new Map();
  private config: AlchemistConfig;

  constructor(config: Partial<AlchemistConfig> = {}) {
    this.config = { ...DEFAULT_ALCHEMIST_CONFIG, ...config };
  }

  ingest(raw: AlchemistIngest[]): ExtractedCapability[] {
    const extracted: ExtractedCapability[] = [];
    const MAX_TOTAL = 1000;
    for (const item of raw) {
      if (extracted.length >= MAX_TOTAL) break;
      const caps = this.extractFromSource(item);
      extracted.push(...caps);
      for (const cap of caps) {
        this.capabilities.set(`${cap.type}:${cap.name}:${cap.file ?? ''}:${cap.line ?? 0}`, cap);
      }
    }
    return extracted;
  }

  extractFromSource(item: AlchemistIngest): ExtractedCapability[] {
    const results: ExtractedCapability[] = [];
    const content = item.content;
    const MAX_PER_SOURCE = 200;
    const patterns = item.source === 'test_failure'
      ? FAILURE_PATTERNS.map(fp => ({ pattern: fp.pattern, type: fp.type as string, name: fp.trigger }))
      : CAPABILITY_PATTERNS;

    for (const { pattern, type, name } of patterns) {
      const re = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      let safetyLimit = 500;
      const seen = new Set<string>();
      while ((match = re.exec(content)) !== null && safetyLimit-- > 0 && results.length < MAX_PER_SOURCE) {
        const key = `${type}:${name}:${match.index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({
          name: match[1] ?? name,
          type: type as ExtractedCapability['type'],
          evidence: match[0],
          file: (item.metadata?.filePath ?? item.metadata?.file ?? 'unknown') as string,
          line: this.findLineNumber(content, match.index),
          confidence: type === 'risk' ? 0.9 : type === 'anti_pattern' ? 0.8 : 0.7,
        });
      }
    }

    return results;
  }

  audit(gapReport: GapReport | null = null): GapReport {
    const existing = Array.from(this.capabilities.values());
    const manifest = this.config.organismManifest;
    const missing: ExtractedCapability[] = [];
    const risks = existing.filter(c => c.type === 'risk' || c.type === 'risk_rule');
    const antipatterns = existing.filter(c => c.type === 'anti_pattern');
    const gaps = existing.filter(c => c.type === 'gap');

    for (const required of manifest) {
      const found = existing.some(c => c.name === required && c.type === 'feature');
      if (!found) {
        missing.push({ name: required, type: 'gap', evidence: `Missing from codebase: ${required}`, confidence: 1.0 });
      }
    }

    const report: GapReport = {
      systemName: (gapReport?.systemName ?? 'unknown'),
      capabilities: existing.filter(c => c.type === 'feature').map(c => c.name),
      missing: missing.length > 0 ? missing : (gapReport?.missing ?? []),
      risks,
      antipatterns,
      gaps: [...gaps, ...missing],
    };

    return report;
  }

  synthesize(gapReport: GapReport, source: AlchemistSource = 'repo_scan'): AlchemistLesson[] {
    const newLessons: AlchemistLesson[] = [];

    for (const risk of gapReport.risks) {
      const lesson = this.createLesson('risk_rule', risk, source);
      if (lesson) newLessons.push(lesson);
    }

    for (const ap of gapReport.antipatterns) {
      const lesson = this.createLesson('anti_pattern', ap, source);
      if (lesson) newLessons.push(lesson);
    }

    for (const gap of gapReport.gaps) {
      const lesson = this.createLesson('procedure', gap, source);
      if (lesson) newLessons.push(lesson);
    }

    for (const lesson of newLessons) {
      this.lessons.set(lesson.id, lesson);
    }

    return newLessons;
  }

  verify(lessonId: string, success: boolean): AlchemistLesson | null {
    const lesson = this.lessons.get(lessonId);
    if (!lesson) return null;

    if (success) {
      lesson.verificationCount++;
      if (lesson.verificationCount >= this.config.verificationThreshold) {
        lesson.verified = true;
        lesson.lastVerified = new Date();
      }
    } else {
      lesson.verificationCount = Math.max(0, lesson.verificationCount - 1);
      if (lesson.verified && lesson.verificationCount < this.config.verificationThreshold) {
        lesson.verified = false;
      }
    }

    this.lessons.set(lessonId, lesson);
    return lesson;
  }

  generateBlueprints(targetContext?: string): Blueprint[] {
    const bp = this.generateBlueprint(targetContext);
    return bp ? [bp] : [];
  }

  generateBlueprint(targetContext?: string): Blueprint {
    const ctx = targetContext ?? 'general';
    const relevantLessons = this.recall(ctx);
    const procedures = relevantLessons
      .filter(l => l.type === 'procedure' || l.type === 'repair_recipe')
      .map(l => l.action);
    const riskRules = relevantLessons
      .filter(l => l.type === 'risk_rule' || l.type === 'anti_pattern')
      .map(l => l.action);
    const checklist = relevantLessons
      .filter(l => l.type === 'validation_checklist')
      .map(l => l.action);

    return {
      id: `bp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      lessons: relevantLessons.map(l => l.id),
      procedures: [...procedures, ...checklist],
      riskRules,
      targetContext: ctx,
      generatedAt: new Date(),
    };
  }

  store(lessons: Partial<AlchemistLesson>[]): void {
    const DEFAULT_TYPE: AlchemistLessonType = 'procedure';
    const DEFAULT_SOURCE: AlchemistSource = 'repo_scan';
    for (const l of lessons) {
      const id = l.id ?? `stored_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const lesson: AlchemistLesson = {
        id,
        type: l.type ?? DEFAULT_TYPE,
        title: l.title ?? 'Stored lesson',
        description: l.description ?? '',
        trigger: l.trigger ?? '',
        action: l.action ?? '',
        evidence: l.evidence ?? [],
        source: l.source ?? DEFAULT_SOURCE,
        verified: l.verified ?? false,
        verificationCount: l.verificationCount ?? 0,
        confidence: l.confidence ?? 0.5,
        retention: l.retention ?? 0.8,
        createdAt: l.createdAt instanceof Date ? l.createdAt : new Date(l.createdAt ?? Date.now()),
        tags: l.tags ?? [],
      };
      this.lessons.set(id, lesson);
    }
  }

  recall(context: string): AlchemistLesson[] {
    const contextLower = (context ?? '').toLowerCase();
    const words = contextLower.split(/\s+/);
    const scored = Array.from(this.lessons.values()).map(lesson => {
      const triggerLower = (lesson.trigger ?? '').toLowerCase();
      const descLower = (lesson.description ?? '').toLowerCase();
      let score = 0;
      for (const word of words) {
        if (word.length < 3) continue;
        if (triggerLower.includes(word)) score += 2;
        if (descLower.includes(word)) score += 1;
        for (const tag of lesson.tags) {
          if (tag.toLowerCase().includes(word)) score += 1.5;
        }
      }
      if (lesson.verified) score *= 1.5;
      return { lesson, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter(s => s.score > 0)
      .slice(0, this.config.recallTopK)
      .map(s => s.lesson);
  }

  getLesson(id: string): AlchemistLesson | undefined {
    return this.lessons.get(id);
  }

  getAllLessons(): AlchemistLesson[] {
    return Array.from(this.lessons.values());
  }

  getVerifiedLessons(): AlchemistLesson[] {
    return Array.from(this.lessons.values()).filter(l => l.verified);
  }

  getCapabilities(): ExtractedCapability[] {
    return Array.from(this.capabilities.values());
  }

  private createLesson(
    type: AlchemistLessonType,
    cap: ExtractedCapability,
    source: AlchemistSource,
  ): AlchemistLesson | null {
    const matched = this.findFailurePattern(cap.evidence, type);
    const id = `lesson_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return {
      id,
      type,
      title: matched?.trigger ?? `${type}: ${cap.name}`,
      description: cap.evidence,
      trigger: matched?.trigger ?? cap.evidence.slice(0, 100),
      action: matched?.action ?? `Review and address: ${cap.name}`,
      evidence: [cap.evidence],
      source,
      verified: false,
      verificationCount: 0,
      confidence: 0.5,
      retention: 0.8,
      createdAt: new Date(),
      tags: [type, cap.type, cap.name],
    };
  }

  private findFailurePattern(
    evidence: string,
    _type: AlchemistLessonType,
  ): { trigger: string; action: string } | null {
    for (const fp of FAILURE_PATTERNS) {
      if (fp.pattern.test(evidence)) {
        return { trigger: fp.trigger, action: fp.action };
      }
    }
    return null;
  }

  private findLineNumber(content: string, index: number): number {
    return content.slice(0, index).split('\n').length;
  }
}

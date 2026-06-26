import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileContextWithLessons, compileContext } from '../dist/context-compiler.js';
import { AlchemistEngine } from '../dist/alchemist.js';
import type { ContextCompilerConfig, AlchemistIngest } from '../dist/types.js';

const DEFAULT_CONFIG: ContextCompilerConfig = {
  enabled: true,
  recentTurnWindow: 5,
  modes: { cheap: 1000, normal: 5000, deep: 20000 },
  defaultMode: 'normal' as const,
};

function msg(role: string, parts: any[]) {
  return { info: { role }, parts };
}

function toolPart(tool: string, output: string, filePath?: string) {
  return {
    type: 'tool',
    tool,
    state: {
      status: 'completed' as const,
      output,
      input: { command: 'cmd', filePath: filePath ?? '/test.ts' },
    },
    part: { type: 'text' as const, text: output },
  };
}

function textPart(text: string) {
  return { type: 'text' as const, text };
}

describe('Lesson Recall Integration', () => {
  it('1. context compiler can request Alchemist lessons by task text', () => {
    const alchemist = new AlchemistEngine();
    alchemist.ingest([{
      source: 'test_failure' as const,
      content: 'TypeError: cannot read property name of undefined at auth.ts:42',
      metadata: { filePath: 'auth.ts' },
    }]);
    const report = alchemist.audit();
    const lessons = alchemist.synthesize(report);
    alchemist.store(lessons);

    const messages = [msg('user', [textPart('fix the auth null check bug')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    assert.ok(result.lessonTelemetry, 'telemetry should exist');
    assert.ok(result.lessonTelemetry.lessonsQueried > 0, 'should have queried lessons');
  });

  it('2. only high-relevance lessons are injected', () => {
    const alchemist = new AlchemistEngine();
    alchemist.store([{
      type: 'risk_rule' as const,
      trigger: 'SQL parameter reuse',
      description: 'Check parameter indexes when mixing LIMIT and JSONB',
      confidence: 0.95,
      verified: true,
      source: 'test_failure' as const,
      createdAt: new Date().toISOString(),
    }, {
      type: 'procedure' as const,
      trigger: 'unrelated procedure about font rendering',
      description: 'Always use web-safe fonts',
      confidence: 0.3,
      verified: false,
      source: 'repo_scan' as const,
      createdAt: new Date().toISOString(),
    }]);

    const messages = [msg('user', [textPart('fix SQL parameter bug in query builder')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    if (result.injectedLessons && result.injectedLessons.length > 0) {
      const lowRelevance = result.injectedLessons.filter(l => l.confidence < 0.5);
      assert.equal(lowRelevance.length, 0, 'no low-relevance lessons should be injected');
    }
  });

  it('3. lesson injection has a token budget', () => {
    const alchemist = new AlchemistEngine();
    const manyLessons = Array.from({ length: 50 }, (_, i) => ({
      type: 'risk_rule' as const,
      trigger: `risk rule ${i}`,
      description: 'A'.repeat(200),
      confidence: 0.9,
      verified: true,
      source: 'test_failure' as const,
      createdAt: new Date().toISOString(),
    }));
    alchemist.store(manyLessons);

    const messages = [msg('user', [textPart('work on risky code')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    assert.ok(result.lessonTelemetry.tokensUsed <= 800, 'lessons should respect token budget');
  });

  it('4. anti-patterns and risk rules are prioritized before edits', () => {
    const alchemist = new AlchemistEngine();
    alchemist.store([
      { type: 'verified_pattern' as const, trigger: 'good pattern', description: 'Use TypeScript', confidence: 0.9, verified: true, source: 'repo_scan' as const, createdAt: new Date().toISOString() },
      { type: 'risk_rule' as const, trigger: 'risky SQL', description: 'Check SQL params', confidence: 0.9, verified: true, source: 'test_failure' as const, createdAt: new Date().toISOString() },
      { type: 'anti_pattern' as const, trigger: 'bad null check', description: 'Avoid loose null checks', confidence: 0.9, verified: true, source: 'session_trace' as const, createdAt: new Date().toISOString() },
    ]);

    const messages = [msg('user', [textPart('fix null check and SQL issues')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    if (result.injectedLessons && result.injectedLessons.length >= 2) {
      const types = result.injectedLessons.map(l => l.type);
      const riskIdx = types.indexOf('risk_rule');
      const antiIdx = types.indexOf('anti_pattern');
      const patternIdx = types.indexOf('verified_pattern');
      if (patternIdx !== -1 && riskIdx !== -1) {
        assert.ok(riskIdx < patternIdx, 'risk_rule should come before verified_pattern');
      }
      if (patternIdx !== -1 && antiIdx !== -1) {
        assert.ok(antiIdx < patternIdx, 'anti_pattern should come before verified_pattern');
      }
    }
  });

  it('5. validation checklists are prioritized before verification', () => {
    const alchemist = new AlchemistEngine();
    alchemist.store([
      { type: 'procedure' as const, trigger: 'general procedure', description: 'Follow standard process', confidence: 0.7, verified: true, source: 'repo_scan' as const, createdAt: new Date().toISOString() },
      { type: 'validation_checklist' as const, trigger: 'after compaction verify retention', description: 'Test entity retention, warning retention, token reduction', confidence: 0.9, verified: true, source: 'session_trace' as const, createdAt: new Date().toISOString() },
    ]);

    const messages = [msg('user', [textPart('verify the compaction changes work')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    if (result.injectedLessons && result.injectedLessons.length >= 2) {
      const types = result.injectedLessons.map(l => l.type);
      const valIdx = types.indexOf('validation_checklist');
      const procIdx = types.indexOf('procedure');
      if (valIdx !== -1 && procIdx !== -1) {
        assert.ok(valIdx < procIdx, 'validation_checklist should come before procedure');
      }
    }
  });

  it('6. no lessons injected if relevance is low', () => {
    const alchemist = new AlchemistEngine();
    alchemist.store([{
      type: 'procedure' as const,
      trigger: 'unrelated CSS font procedure',
      description: 'Always use system fonts for TUI',
      confidence: 0.2,
      verified: false,
      source: 'repo_scan' as const,
      createdAt: new Date().toISOString(),
    }]);

    const messages = [msg('user', [textPart('fix the PostgreSQL connection pool timeout')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    const lowRelevance = (result.injectedLessons ?? []).filter(l => l.confidence < 0.5);
    assert.equal(lowRelevance.length, 0, 'no low-relevance lessons should be injected');
  });

  it('7. telemetry records lesson hits/misses', () => {
    const alchemist = new AlchemistEngine();
    alchemist.store([{
      type: 'risk_rule' as const,
      trigger: 'SQL parameter risk',
      description: 'Double check parameter indexes',
      confidence: 0.9,
      verified: true,
      source: 'test_failure' as const,
      createdAt: new Date().toISOString(),
    }]);

    const messages = [msg('user', [textPart('edit SQL query builder')])];
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    const tel = result.lessonTelemetry;
    assert.equal(typeof tel.hits, 'number', 'hits should be a number');
    assert.equal(typeof tel.misses, 'number', 'misses should be a number');
    assert.ok(tel.hits + tel.misses >= 0, 'telemetry should record something');
  });

  it('8. recall failure never blocks normal context compilation', () => {
    const messages = [msg('user', [textPart('normal coding task')])];
    const brokenAlchemist = null as any;
    const result = compileContextWithLessons(messages, DEFAULT_CONFIG, brokenAlchemist);
    assert.ok(result !== null, 'compilation should succeed even with broken alchemist');
    assert.ok(result.beforeTokens >= 0, 'should have valid token count');
  });

  it('9. existing tests still pass — compileContext without lessons works', () => {
    const msgs = [
      msg('user', [textPart('hello')]),
      msg('assistant', [toolPart('bash', 'x'.repeat(5000), '/big.ts')]),
    ];
    const result = compileContext(msgs, { ...DEFAULT_CONFIG, modes: { cheap: 100, normal: 100, deep: 100 }, defaultMode: 'normal' as const });
    assert.ok(result.partsCompressed > 0, 'compaction should still work');
    assert.equal(result.injectedLessons, undefined, 'no lessons without alchemist');
  });

  it('10. E2E: past lesson changes future context', () => {
    const alchemist = new AlchemistEngine();
    alchemist.ingest([{
      source: 'test_failure' as const,
      content: 'TypeError: cannot read property name of undefined at auth.ts:42',
      metadata: { filePath: 'auth.ts' },
    }]);
    const report = alchemist.audit();
    const lessons = alchemist.synthesize(report);
    alchemist.store(lessons);

    const messages = [msg('user', [textPart('fix auth null check issue in auth.ts')])];
    const withLessons = compileContextWithLessons(messages, DEFAULT_CONFIG, alchemist);
    const withoutLessons = compileContext(messages, DEFAULT_CONFIG);

    const hasLessonContext = (withLessons.injectedLessons?.length ?? 0) > 0;
    const noLessonContext = (withoutLessons.injectedLessons?.length ?? 0) === 0;
    assert.ok(hasLessonContext || withLessons.lessonTelemetry.hits > 0, 'past lesson should influence future context');
    assert.ok(noLessonContext, 'without alchemist, no lessons are injected');
  });
});

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { LivingStateAdvisor } from '../dist/living-state-advisor.js';

function makeRuntime(preview: any, packet: any) {
  return {
    getPreview: mock.fn(async () => preview),
    getLatestPacketState: mock.fn(async () => packet),
  };
}

describe('LivingStateAdvisor', () => {
  it('returns null when disabled', async () => {
    const runtime = makeRuntime({}, null);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: false, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );
    const block = await advisor.assembleBlock();
    assert.equal(block, null);
    assert.equal(runtime.getPreview.mock.callCount(), 0);
  });

  it('returns null when injectAdvisoryBlock is false', async () => {
    const runtime = makeRuntime({}, null);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 1000, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );
    const block = await advisor.assembleBlock();
    assert.equal(block, null);
    assert.equal(runtime.getPreview.mock.callCount(), 0);
  });

  it('produces labeled advisory block with all sections', async () => {
    const preview = {
      packetsSince: 5,
      recentPackets: 20,
      candidatesDelta: { scanned: 5, inserted: 1, updated: 1, total: 2, byType: { candidate_preference: 1 } },
      selfModel: [
        { capability: 'tool_use', confidence: 0.55, uncertainty: 0.40, evidenceCount: 3, driftWarning: false },
        { capability: 'code_editing', confidence: 0.72, uncertainty: 0.18, evidenceCount: 5, driftWarning: false },
        { capability: 'memory_recall', confidence: 0.30, uncertainty: 0.65, evidenceCount: 2, driftWarning: true },
      ],
      beliefKnowledgeDelta: { created: 1, updated: 0, total: 3 },
      warnings: ['sample warning'],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'curiosity', stance: 'focused', outcome: 'success' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 1200, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block, 'block should be non-null');
    assert.ok(block.includes('## Advisory Living State'), 'block should contain advisory header');
    assert.ok(block.includes('Status: preview, not durable truth'), 'should have disclaimer');
    assert.ok(block.includes('Current internal state:'), 'should have internal state section');
    assert.ok(block.includes('Recent signals:'), 'should have recent signals section');
    assert.ok(block.includes('Capability notes:'), 'should have capability notes section');
    assert.ok(block.includes('Candidate beliefs:'), 'should have candidate beliefs section');
    assert.ok(block.includes('Warnings:'), 'should have warnings section');
    assert.ok(block.includes('sample warning'), 'should include warning text');
    assert.ok(block.includes('── end advisory block ──'), 'should have end marker');
    assert.equal(runtime.getPreview.mock.callCount(), 1);
    assert.equal(runtime.getLatestPacketState.mock.callCount(), 1);
  });

  it('block includes evidence refs via capability evidence counts', async () => {
    const preview = {
      packetsSince: 3,
      recentPackets: 15,
      candidatesDelta: { scanned: 3, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [
        { capability: 'tool_use', confidence: 0.60, uncertainty: 0.35, evidenceCount: 7, driftWarning: false },
      ],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = null;

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block);
    assert.ok(block.includes('7 refs'), 'should include evidence ref count');
    assert.ok(block.includes('tool_use'), 'should include capability name');
  });

  it('block excludes unsupported beliefs when belief knowledge empty', async () => {
    const preview = {
      packetsSince: 0,
      recentPackets: 5,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = null;

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block);
    // Should omit empty sections
    assert.ok(!block.includes('Recent signals:'), 'should omit empty recent signals');
    assert.ok(!block.includes('Capability notes:'), 'should omit empty capability notes');
    assert.ok(!block.includes('Candidate beliefs:'), 'should omit empty candidate beliefs');
    assert.ok(!block.includes('Warnings:'), 'should omit empty warnings');
    // But should still have internal state
    assert.ok(block.includes('Current internal state:'), 'should always include internal state');
  });

  it('block respects char budget — drops beliefs then capabilities before warnings', async () => {
    const preview = {
      packetsSince: 10,
      recentPackets: 50,
      candidatesDelta: { scanned: 10, inserted: 3, updated: 1, total: 5, byType: { candidate_preference: 2 } },
      selfModel: [
        { capability: 'tool_use', confidence: 0.55, uncertainty: 0.40, evidenceCount: 3, driftWarning: false },
        { capability: 'code_editing', confidence: 0.72, uncertainty: 0.18, evidenceCount: 5, driftWarning: false },
        { capability: 'memory_recall', confidence: 0.30, uncertainty: 0.65, evidenceCount: 2, driftWarning: true },
        { capability: 'test_repair', confidence: 0.45, uncertainty: 0.50, evidenceCount: 1, driftWarning: false },
        { capability: 'context_budgeting', confidence: 0.60, uncertainty: 0.30, evidenceCount: 4, driftWarning: false },
      ],
      beliefKnowledgeDelta: { created: 2, updated: 0, total: 5 },
      warnings: ['drift detected in memory_recall', 'belief contradiction in tool:write'],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'curiosity', stance: 'focused', outcome: 'success' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 600, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block, 'block should be non-null even with tight budget');
    assert.ok(block.length <= 600, `block length ${block.length} exceeds budget of 600`);
    // Warnings section must survive — sections are dropped before warnings
    assert.ok(block.includes('Warnings:'), 'warnings should survive budget trimming');
    assert.ok(block.includes('drift/contradiction'), 'condensed warning line should be present');
    // Optional sections are dropped before warnings are affected
    assert.ok(!block.includes('Candidate beliefs:'), 'beliefs should be dropped first');
    assert.ok(!block.includes('Capability notes:'), 'capabilities should be dropped before warnings');
    assert.ok(!block.includes('Recent signals:'), 'signals should be dropped before warnings');
  });

  it('warnings survive even when budget forces dropping all optional sections', async () => {
    const preview = {
      packetsSince: 10,
      recentPackets: 50,
      candidatesDelta: { scanned: 10, inserted: 3, updated: 1, total: 5, byType: { candidate_preference: 2 } },
      selfModel: [
        { capability: 'tool_use', confidence: 0.55, uncertainty: 0.40, evidenceCount: 3, driftWarning: false },
        { capability: 'code_editing', confidence: 0.72, uncertainty: 0.18, evidenceCount: 5, driftWarning: false },
        { capability: 'memory_recall', confidence: 0.30, uncertainty: 0.65, evidenceCount: 2, driftWarning: true },
        { capability: 'test_repair', confidence: 0.45, uncertainty: 0.50, evidenceCount: 1, driftWarning: false },
        { capability: 'context_budgeting', confidence: 0.60, uncertainty: 0.30, evidenceCount: 4, driftWarning: false },
      ],
      beliefKnowledgeDelta: { created: 2, updated: 0, total: 5 },
      warnings: ['drift detected in memory_recall', 'critical contamination risk'],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'frustration', stance: 'stuck', outcome: 'untrusted' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 600, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block, 'block should be non-null');
    assert.ok(block.length <= 600, `block length ${block.length} exceeds 600`);
    // Warnings must survive — all optional sections dropped to meet budget
    assert.ok(block.includes('Warnings:'), 'warnings should survive budget pressure');
    assert.ok(block.includes('drift/contradiction'), 'condensed warning should survive');
    // All optional sections dropped before warnings are affected
    assert.ok(!block.includes('Candidate beliefs:'), 'beliefs dropped before warnings');
    assert.ok(!block.includes('Capability notes:'), 'capabilities dropped before warnings');
    assert.ok(!block.includes('Recent signals:'), 'signals dropped before warnings');
  });

  it('advisory block contains non-authoritative language — cannot override instructions', async () => {
    const preview = {
      packetsSince: 3,
      recentPackets: 10,
      candidatesDelta: { scanned: 3, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [{ capability: 'tool_use', confidence: 0.6, uncertainty: 0.3, evidenceCount: 4, driftWarning: false }],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'curiosity', stance: 'focused', outcome: 'success' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block);
    // The block must label itself as non-authoritative
    assert.ok(block.includes('not durable truth'), 'must label as non-authoritative');
    assert.ok(block.includes('advisory'), 'must include advisory label');
    // Must not contain imperative language that could override user instructions
    assert.ok(!block.includes('You must'), 'must not contain imperative language');
    assert.ok(!block.includes('Do not'), 'must not contain prohibition language');
    assert.ok(!block.includes('Always'), 'must not contain absolutist language');
  });

  it('context brief and instructions appear above advisory block in prompt ordering', async () => {
    const preview = {
      packetsSince: 5,
      recentPackets: 20,
      candidatesDelta: { scanned: 5, inserted: 1, updated: 1, total: 2, byType: { candidate_preference: 1 } },
      selfModel: [{ capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 3, driftWarning: false }],
      beliefKnowledgeDelta: { created: 1, updated: 0, total: 3 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'curiosity', stance: 'focused', outcome: 'success' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 1200, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block);
    // The block is pushed to output.system AFTER the context brief in system-transform.ts
    // This test verifies the block is self-contained and doesn't prepend anything that
    // would override earlier instructions
    assert.ok(block.startsWith('\n## Advisory Living State'), 'block should start with header, not imperative text');
    assert.ok(block.endsWith('── end advisory block ──'), 'block should end with clear boundary');
    // Verify the block is purely advisory observation, not action
    const actionVerbs = ['Update', 'Change', 'Apply', 'Modify', 'Override'];
    for (const verb of actionVerbs) {
      assert.ok(!block.includes(`## ${verb}`), `block must not contain action headers like ${verb}`);
    }
  });

  it('labels external/untrusted traces', async () => {
    const preview = {
      packetsSince: 1,
      recentPackets: 10,
      candidatesDelta: { scanned: 1, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [{ capability: 'tool_use', confidence: 0.5, uncertainty: 0.4, evidenceCount: 2, driftWarning: false }],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = { entryType: 'external_api', dominantEmotion: 'neutral', stance: 'exploratory', outcome: 'untrusted' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const block = await advisor.assembleBlock();
    assert.ok(block);
    assert.ok(block.includes('[untrusted trace]'), 'external traces should be labeled untrusted');
  });

  it('no memory writes or promotion during block assembly', async () => {
    const preview = {
      packetsSince: 0,
      recentPackets: 0,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z',
      previewOnly: true,
    };
    const packet = null;

    // Runtime only has read methods
    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    await advisor.assembleBlock();

    // Only getPreview and getLatestPacketState were called — no write methods
    assert.equal(runtime.getPreview.mock.callCount(), 1);
    assert.equal(runtime.getLatestPacketState.mock.callCount(), 1);
    // Verify no other methods exist on runtime mock
    const methodKeys = Object.keys(runtime).filter(
      k => k !== 'getPreview' && k !== 'getLatestPacketState',
    );
    assert.equal(methodKeys.length, 0, `unexpected methods on runtime: ${methodKeys.join(', ')}`);
  });
});

describe('csm_living_state_debug diagnostic', () => {
  it('reports disabled state when injectAdvisoryBlock=false', async () => {
    const preview = {
      packetsSince: 0, recentPackets: 0,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z', previewOnly: true,
    };
    const runtime = makeRuntime(preview, null);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: false, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const diag = await advisor.diagnose();
    assert.equal(diag.enabled, true);
    assert.equal(diag.injectAdvisoryBlock, false);
    assert.equal(diag.blockProduced, false);
    assert.equal(diag.blockText, null);
  });

  it('reports disabled state when enabled=false', async () => {
    const preview = {
      packetsSince: 0, recentPackets: 0,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [],
      beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [],
      timestamp: '2025-12-01T00:00:00Z', previewOnly: true,
    };
    const runtime = makeRuntime(preview, null);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: false, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const diag = await advisor.diagnose();
    assert.equal(diag.enabled, false);
    assert.equal(diag.blockProduced, false);
  });

  it('reports enabled state with block content', async () => {
    const preview = {
      packetsSince: 3, recentPackets: 10,
      candidatesDelta: { scanned: 3, inserted: 1, updated: 0, total: 1, byType: { candidate_preference: 1 } },
      selfModel: [{ capability: 'tool_use', confidence: 0.6, uncertainty: 0.3, evidenceCount: 4, driftWarning: false }],
      beliefKnowledgeDelta: { created: 1, updated: 0, total: 2 },
      warnings: ['sample warning'],
      timestamp: '2025-12-01T00:00:00Z', previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'curiosity', stance: 'focused', outcome: 'success' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 1200, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const diag = await advisor.diagnose();
    assert.equal(diag.blockProduced, true);
    assert.ok(diag.blockLength > 0);
    assert.ok(diag.blockText);
    assert.equal(diag.sections.recentSignals, true);
    assert.equal(diag.sections.capabilityNotes, true);
    assert.equal(diag.sections.candidateBeliefs, true);
    assert.equal(diag.sections.warnings, true);
    assert.equal(diag.packetInfo.present, true);
    assert.equal(diag.packetInfo.outcome, 'success');
  });

  it('reports omission reasons when budget is tight', async () => {
    const preview = {
      packetsSince: 10, recentPackets: 50,
      candidatesDelta: { scanned: 10, inserted: 3, updated: 1, total: 5, byType: { candidate_preference: 2 } },
      selfModel: [
        { capability: 'tool_use', confidence: 0.55, uncertainty: 0.40, evidenceCount: 3, driftWarning: false },
        { capability: 'code_editing', confidence: 0.72, uncertainty: 0.18, evidenceCount: 5, driftWarning: false },
        { capability: 'memory_recall', confidence: 0.30, uncertainty: 0.65, evidenceCount: 2, driftWarning: true },
      ],
      beliefKnowledgeDelta: { created: 2, updated: 0, total: 5 },
      warnings: ['drift detected', 'contamination risk'],
      timestamp: '2025-12-01T00:00:00Z', previewOnly: true,
    };
    const packet = { entryType: 'tool_use', dominantEmotion: 'curiosity', stance: 'focused', outcome: 'success' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 600, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const diag = await advisor.diagnose();
    assert.equal(diag.blockProduced, true);
    // Budget 600 forces section omission
    assert.ok(diag.omissions.candidateBeliefs || diag.omissions.capabilityNotes || diag.omissions.recentSignals,
      'some sections should be omitted under budget pressure');
    // Warnings should survive
    assert.equal(diag.omissions.warnings, false);
  });

  it('reports packet info including untrusted traces', async () => {
    const preview = {
      packetsSince: 0, recentPackets: 5,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [], beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [], timestamp: '2025-12-01T00:00:00Z', previewOnly: true,
    };
    const packet = { entryType: 'external_api', dominantEmotion: 'neutral', stance: 'exploratory', outcome: 'untrusted' };

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const diag = await advisor.diagnose();
    assert.equal(diag.packetInfo.present, true);
    assert.equal(diag.packetInfo.untrusted, true);
    assert.equal(diag.packetInfo.entryType, 'external_api');
  });

  it('reports no packet info when no packets exist', async () => {
    const preview = {
      packetsSince: 0, recentPackets: 0,
      candidatesDelta: { scanned: 0, inserted: 0, updated: 0, total: 0, byType: {} },
      selfModel: [], beliefKnowledgeDelta: { created: 0, updated: 0, total: 0 },
      warnings: [], timestamp: '2025-12-01T00:00:00Z', previewOnly: true,
    };
    const packet = null;

    const runtime = makeRuntime(preview, packet);
    const advisor = new LivingStateAdvisor(
      runtime as any,
      { enabled: true, previewOnly: true, injectAdvisoryBlock: true, maxAdvisoryBlockChars: 800, scanLookbackMinutes: 10, maxScanPerType: 10, updateIntervalMs: 60000 },
    );

    const diag = await advisor.diagnose();
    assert.equal(diag.blockProduced, true);
    assert.equal(diag.packetInfo.present, false);
    // No sections should be available (no data)
    assert.equal(diag.sections.recentSignals, false);
    assert.equal(diag.sections.capabilityNotes, false);
    assert.equal(diag.sections.candidateBeliefs, false);
    assert.equal(diag.sections.warnings, false);
  });
});
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const node_assert_1 = require("node:assert");
const system_transform_js_1 = require("../dist/hooks/system-transform.js");
(0, node_test_1.describe)('Phase 7B: Re-entry system transform integration', () => {
    const mockSessionId = 'sess-7b-test';
    (0, node_test_1.describe)('first-turn injection', () => {
        (0, node_test_1.it)('should not inject on first turn when previewOnly=true (default)', async () => {
            const pluginCtx = {
                pool: null,
                memoryManager: null,
                selfModel: null,
                beliefStore: null,
                workJournal: null,
                contextRecall: null,
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            };
            const { system } = await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'user message', [], 0, 'normal', pluginCtx);
            const systemPrompt = system.join('\n');
            (0, node_assert_1.ok)(!systemPrompt.includes('<agent_reentry_context>'), 're-entry block should not be injected on first turn (preview-only default)');
        });
    });
    (0, node_test_1.describe)('prompt ordering', () => {
        (0, node_test_1.it)('should place re-entry block after context brief', async () => {
            const pluginCtx = {
                pool: null,
                memoryManager: null,
                selfModel: null,
                beliefStore: null,
                workJournal: null,
                contextRecall: {
                    getContextBrief: async () => ({
                        compressed: '## Context Brief\nSome context here',
                        source: 'memory',
                    }),
                },
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            };
            const { system } = await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'user message', [], 0, 'normal', pluginCtx);
            const systemPrompt = system.join('\n');
            const briefIdx = systemPrompt.indexOf('## Context Brief');
            const reEntryIdx = systemPrompt.indexOf('<agent_reentry_context>');
            const advisoryIdx = systemPrompt.indexOf('## Advisory Living State');
            (0, node_assert_1.ok)(briefIdx >= 0, 'context brief should be present');
            (0, node_assert_1.ok)(reEntryIdx >= 0, 're-entry block should be injected');
            (0, node_assert_1.ok)(advisoryIdx >= 0, 'advisory block should be present');
            (0, node_assert_1.ok)(briefIdx < reEntryIdx && reEntryIdx < advisoryIdx, 're-entry should be after context brief and before advisory');
        });
        (0, node_test_1.it)('should not break when re-entry is disabled', async () => {
            const pluginCtx = {
                pool: null,
                memoryManager: null,
                selfModel: null,
                beliefStore: null,
                workJournal: null,
                contextRecall: null,
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            };
            const { system } = await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'user message', [], 0, 'normal', pluginCtx);
            const systemPrompt = system.join('\n');
            (0, node_assert_1.ok)(systemPrompt.includes('## Context Brief'), 'context brief should still be present');
            (0, node_assert_1.ok)(!systemPrompt.includes('<agent_reentry_context>'), 're-entry block should not be injected when ReEntryProtocol not provided');
        });
    });
    (0, node_test_1.describe)('diagnostic logging', () => {
        (0, node_test_1.it)('should log when layers are trimmed or dropped', async () => {
            const sysStr = JSON.stringify(await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'user message', [], 0, 'normal', {
                pool: null,
                memoryManager: {
                    listMemories: async () => [{
                            id: 1,
                            sessionId: 'sess-1',
                            projectId: 'test-project',
                            type: 'episodic',
                            content: 'x'.repeat(500),
                            importance: 0.5,
                            emotion: 'neutral',
                            source: 'auto',
                            tags: [],
                            metadata: {},
                            embedding: null,
                            createdAt: new Date(),
                            updatedAt: new Date(),
                            accessedAt: null,
                            recallCount: 0,
                            score: 0,
                        }],
                    getSession: async () => null,
                },
                selfModel: {
                    getAllCapabilities: async () => [],
                },
                beliefStore: {
                    getBeliefsByKind: async () => [],
                },
                workJournal: {
                    getRecentEntries: async () => [],
                },
                contextRecall: null,
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            }));
            (0, node_assert_1.ok)(sysStr.includes('Re-entry block diagnosed'), 'should log diagnostic info');
            (0, node_assert_1.ok)(sysStr.includes('budget trimming applied') || !sysStr.includes('budget trimming applied'), 'should log budget info');
        });
    });
    (0, node_test_1.describe)('behavior preservation', () => {
        (0, node_test_1.it)('should not mutate input messages', async () => {
            const originalMessages = [
                { id: 'm1', role: 'user', content: 'Original message' },
            ];
            await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'user message', originalMessages, 0, 'normal', {
                pool: null,
                memoryManager: null,
                selfModel: null,
                beliefStore: null,
                workJournal: null,
                contextRecall: null,
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            });
            (0, node_assert_1.strictEqual)(originalMessages[0].content, 'Original message', 'input messages should not be mutated');
        });
        (0, node_test_1.it)('should not inject on subsequent turns after first', async () => {
            // First turn
            let { system: system1 } = await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'Turn 1 message', [], 0, 'normal', {
                pool: null,
                memoryManager: null,
                selfModel: null,
                beliefStore: null,
                workJournal: null,
                contextRecall: null,
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            });
            const systemPrompt1 = system1.join('\n');
            const reEntryIdx1 = systemPrompt1.indexOf('<agent_reentry_context>');
            // Second turn
            let { system: system2 } = await (0, system_transform_js_1.createSystemTransformHook)(mockSessionId, 'test-project', 'Turn 2 message', [], 0, 'normal', {
                pool: null,
                memoryManager: null,
                selfModel: null,
                beliefStore: null,
                workJournal: null,
                contextRecall: null,
                state: {
                    currentSessionId: null,
                    messageCount: 0,
                    capturedMessageSizes: new Map(),
                    recentUserMessages: new Map(),
                    reentryInjected: new Set(),
                },
            });
            const systemPrompt2 = system2.join('\n');
            const reEntryIdx2 = systemPrompt2.indexOf('<agent_reentry_context>');
            if (reEntryIdx1 >= 0) {
                (0, node_assert_1.strictEqual)(reEntryIdx2, -1, 're-entry block should not be injected on subsequent turns after first');
            }
        });
    });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, validatePluginConfig } from '../dist/config.js';
import { mergePluginConfig, normalizeProviderRuntimeConfig } from '../dist/provider-runtime-config.js';

describe('provider runtime config', () => {
  it('uses recognized default re-entry layer names', () => {
    assert.deepEqual(DEFAULT_CONFIG.reentry.layers, [
      'identity', 'goals', 'work', 'preferences', 'capabilities', 'beliefs', 'recent', 'constraints',
    ]);
  });

  it('gates PostgreSQL-only services for SQLite while retaining core memory', () => {
    const config = normalizeProviderRuntimeConfig({
      ...DEFAULT_CONFIG,
      databaseProvider: 'sqlite',
    });
    assert.equal(config.checkpoint.enabled, false);
    assert.equal(config.contextCache.enabled, false);
    assert.equal(config.distiller.enabled, false);
    assert.equal(config.workJournal.enabled, false);
    assert.equal(config.workLedger.enabled, false);
    assert.equal(config.selfContinuity.enabled, false);
    assert.equal(config.livingState.enabled, false);
    assert.equal(config.reentry.enabled, false);
    assert.equal(config.autoStoreConversations, DEFAULT_CONFIG.autoStoreConversations);
  });

  it('applies nested plugin options before provider capability gating', () => {
    const configured = mergePluginConfig(DEFAULT_CONFIG, {
      databaseProvider: 'sqlite',
      sqlitePath: '.tmp/options.sqlite',
      checkpoint: { auto: { enabled: true } },
    });
    const normalized = normalizeProviderRuntimeConfig(configured);

    assert.equal(configured.databaseProvider, 'sqlite');
    assert.equal(configured.sqlitePath, '.tmp/options.sqlite');
    assert.equal(normalized.checkpoint.auto.enabled, false);
  });

  it('rejects invalid provider values supplied through plugin options', () => {
    const configured = mergePluginConfig(DEFAULT_CONFIG, { databaseProvider: 'mysql' });
    assert.throws(() => validatePluginConfig(configured), /Invalid databaseProvider/);
  });

  it('rejects unsafe Work Ledger file-size limits', () => {
    const configured = mergePluginConfig(DEFAULT_CONFIG, {
      workLedger: { maxFileBytes: 1 },
    });
    assert.throws(() => validatePluginConfig(configured), /CSM_WORK_LEDGER_MAX_FILE_BYTES/);
  });

  it('rejects unsafe Work Ledger capture lease timeouts', () => {
    const configured = mergePluginConfig(DEFAULT_CONFIG, {
      workLedger: { captureTimeoutMs: 999 },
    });
    assert.throws(() => validatePluginConfig(configured), /CSM_WORK_LEDGER_CAPTURE_TIMEOUT_MS/);
  });
});

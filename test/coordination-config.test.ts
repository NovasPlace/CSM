import { it } from 'node:test';
import assert from 'node:assert/strict';
import {
  coordinationFeatureConfigFromEnv,
  DEFAULT_COORDINATION_FEATURE_CONFIG,
  validateCoordinationFeatureConfig,
  type CoordinationFeatureConfig,
} from '../src/coordination-feature-config.js';
import { CoordinationDomainError } from '../src/coordination/errors.js';
import {
  assertCoordinationEnabled,
  assertMicroAppActionsEnabled,
  assertMicroAppsEnabled,
} from '../src/coordination/feature-gate.js';

it('defaults Coordination Fabric to disabled', () => {
  assert.equal(DEFAULT_COORDINATION_FEATURE_CONFIG.coordination.enabled, false);
});

it('defaults Micro-App Runtime to disabled', () => {
  assert.equal(DEFAULT_COORDINATION_FEATURE_CONFIG.microapps.enabled, false);
});

it('defaults micro-app actions to disabled', () => {
  assert.equal(DEFAULT_COORDINATION_FEATURE_CONFIG.microapps.allowActions, false);
});

it('preserves disabled defaults when options are missing', () => {
  assert.deepEqual(coordinationFeatureConfigFromEnv({}), DEFAULT_COORDINATION_FEATURE_CONFIG);
});

it('accepts the complete experimental flag chain on PostgreSQL', () => {
  const configured = coordinationFeatureConfigFromEnv({
    CSM_COORDINATION_ENABLED: 'true',
    CSM_MICROAPPS_ENABLED: 'true',
    CSM_MICROAPPS_ALLOW_ACTIONS: 'true',
  });
  assert.equal(validateCoordinationFeatureConfig(configured, 'postgres'), configured);
});

it('rejects Micro-App Runtime without Coordination Fabric', () => {
  const configured = features(false, true, false);
  assert.throws(() => validateCoordinationFeatureConfig(configured, 'postgres'), /requires coordination\.enabled/);
});

it('rejects micro-app actions without Micro-App Runtime', () => {
  const configured = features(true, false, true);
  assert.throws(() => validateCoordinationFeatureConfig(configured, 'postgres'), /requires microapps\.enabled/);
});

it('rejects Coordination Fabric on SQLite', () => {
  assert.throws(() => validateCoordinationFeatureConfig(features(true), 'sqlite'), /require PostgreSQL/);
});

it('rejects Micro-App Runtime on SQLite', () => {
  assert.throws(() => coordinationFeatureConfigFromEnv({
    CSM_COORDINATION_ENABLED: 'true', CSM_MICROAPPS_ENABLED: 'true',
  }, 'sqlite'), /require PostgreSQL/);
});

it('rejects non-boolean coordination settings', () => {
  const configured = features() as unknown as { coordination: { enabled: string } };
  configured.coordination.enabled = 'yes';
  assert.throws(
    () => validateCoordinationFeatureConfig(configured as unknown as CoordinationFeatureConfig, 'postgres'),
    /must be boolean/,
  );
});

it('rejects missing micro-app settings', () => {
  const configured = { coordination: { enabled: false } };
  assert.throws(
    () => validateCoordinationFeatureConfig(configured as CoordinationFeatureConfig, 'postgres'),
    /must be boolean/,
  );
});

it('rejects malformed experimental environment flags', () => {
  assert.throws(
    () => coordinationFeatureConfigFromEnv({ CSM_COORDINATION_ENABLED: 'yes' }),
    /must be "true" or "false"/,
  );
});

it('fails the coordination feature gate while disabled', () => {
  assertCode(() => assertCoordinationEnabled(false), 'FEATURE_DISABLED');
});

it('passes the coordination feature gate while enabled', () => {
  assert.doesNotThrow(() => assertCoordinationEnabled(true));
});

it('fails the micro-app gate when its parent is disabled', () => {
  assertCode(() => assertMicroAppsEnabled(false, true), 'FEATURE_DISABLED');
});

it('fails the action gate when actions are disabled', () => {
  assertCode(() => assertMicroAppActionsEnabled(true, true, false), 'FEATURE_DISABLED');
});

it('passes the complete micro-app action gate', () => {
  assert.doesNotThrow(() => assertMicroAppActionsEnabled(true, true, true));
});

function assertCode(action: () => unknown, code: string): void {
  assert.throws(action, (error) => error instanceof CoordinationDomainError && error.code === code);
}

function features(
  coordination = false,
  microapps = false,
  allowActions = false,
): CoordinationFeatureConfig {
  return { coordination: { enabled: coordination }, microapps: { enabled: microapps, allowActions } };
}

export type CoordinationDatabaseProvider = 'postgres' | 'sqlite';

export interface CoordinationFeatureConfig {
  coordination: { enabled: boolean };
  microapps: { enabled: boolean; allowActions: boolean };
}

export const DEFAULT_COORDINATION_FEATURE_CONFIG: CoordinationFeatureConfig = {
  coordination: { enabled: false },
  microapps: { enabled: false, allowActions: false },
};

export function coordinationFeatureConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  provider: CoordinationDatabaseProvider = 'postgres',
): CoordinationFeatureConfig {
  const config = {
    coordination: { enabled: readFlag(env, 'CSM_COORDINATION_ENABLED') },
    microapps: {
      enabled: readFlag(env, 'CSM_MICROAPPS_ENABLED'),
      allowActions: readFlag(env, 'CSM_MICROAPPS_ALLOW_ACTIONS'),
    },
  };
  return validateCoordinationFeatureConfig(config, provider);
}

export function validateCoordinationFeatureConfig(
  config: CoordinationFeatureConfig,
  provider: CoordinationDatabaseProvider,
): CoordinationFeatureConfig {
  if (typeof config.coordination?.enabled !== 'boolean'
    || typeof config.microapps?.enabled !== 'boolean'
    || typeof config.microapps?.allowActions !== 'boolean') {
    throw new Error('Experimental coordination settings must be boolean');
  }
  if (config.microapps.enabled && !config.coordination.enabled) {
    throw new Error('microapps.enabled requires coordination.enabled');
  }
  if (config.microapps.allowActions && !config.microapps.enabled) {
    throw new Error('microapps.allowActions requires microapps.enabled');
  }
  if (provider !== 'postgres' && (config.coordination.enabled || config.microapps.enabled)) {
    throw new Error('Coordination Fabric and Micro-App Runtime require PostgreSQL');
  }
  return config;
}

function readFlag(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
  const value = env[key];
  if (value === undefined || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') return true;
  throw new Error(`${key} must be "true" or "false"`);
}

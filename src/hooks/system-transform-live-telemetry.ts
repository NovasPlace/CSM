import { getLogger } from '../logger.js';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function logSystemTransformTelemetry(
  entry: Record<string, unknown>,
): void {
  getLogger().debug(
    `System transform telemetry: ${JSON.stringify(entry)}`,
    {
      sessionId: optionalString(entry.sessionId),
      projectId: optionalString(entry.projectId),
      layer: 'system_transform',
    },
  );
}


import { CoordinationDomainError } from './errors.js';

export function assertCoordinationEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new CoordinationDomainError('FEATURE_DISABLED', 'Coordination Fabric is disabled');
  }
}

export function assertMicroAppsEnabled(coordination: boolean, microapps: boolean): void {
  assertCoordinationEnabled(coordination);
  if (!microapps) {
    throw new CoordinationDomainError('FEATURE_DISABLED', 'Micro-App Runtime is disabled');
  }
}

export function assertMicroAppActionsEnabled(
  coordination: boolean,
  microapps: boolean,
  allowActions: boolean,
): void {
  assertMicroAppsEnabled(coordination, microapps);
  if (!allowActions) {
    throw new CoordinationDomainError('FEATURE_DISABLED', 'Micro-App actions are disabled');
  }
}

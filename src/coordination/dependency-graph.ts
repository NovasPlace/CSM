import { CoordinationDomainError } from './errors.js';
import type { AssignmentStatus, CoordinationDependency } from './types.js';

export function assertAcyclicDependencies(
  dependencies: readonly CoordinationDependency[],
  workspaceId: string,
): void {
  const cycle = findDependencyCycle(dependencies, workspaceId);
  if (cycle) {
    throw new CoordinationDomainError('ASSIGNMENT_DEPENDENCY_UNRESOLVED', 'Dependency cycle detected', {
      workspaceId, cycle,
    });
  }
}

export function findDependencyCycle(
  dependencies: readonly CoordinationDependency[],
  workspaceId: string,
): string[] | null {
  const graph = buildGraph(dependencies, workspaceId);
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];
  for (const node of graph.keys()) {
    const cycle = visit(node, graph, visited, active, path);
    if (cycle) return cycle;
  }
  return null;
}

export function areDependenciesSatisfied(
  workspaceId: string,
  assignmentId: string,
  dependencies: readonly CoordinationDependency[],
  statuses: ReadonlyMap<string, ReadonlyMap<string, AssignmentStatus>>,
): boolean {
  const workspaceStatuses = statuses.get(workspaceId);
  return dependencies
    .filter((dependency) =>
      dependency.workspaceId === workspaceId && dependency.assignmentId === assignmentId)
    .every((dependency) => workspaceStatuses?.get(dependency.dependsOnAssignmentId) === 'completed');
}

export function addDependency(
  dependencies: readonly CoordinationDependency[],
  candidate: CoordinationDependency,
): CoordinationDependency[] {
  const duplicate = dependencies.some((dependency) =>
    dependency.workspaceId === candidate.workspaceId
      && dependency.assignmentId === candidate.assignmentId
      && dependency.dependsOnAssignmentId === candidate.dependsOnAssignmentId);
  const next = duplicate ? [...dependencies] : [...dependencies, candidate];
  assertAcyclicDependencies(next, candidate.workspaceId);
  return next;
}

function buildGraph(
  dependencies: readonly CoordinationDependency[],
  workspaceId: string,
): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const dependency of dependencies) {
    if (dependency.workspaceId !== workspaceId) continue;
    const edges = graph.get(dependency.assignmentId) ?? [];
    edges.push(dependency.dependsOnAssignmentId);
    graph.set(dependency.assignmentId, edges);
    if (!graph.has(dependency.dependsOnAssignmentId)) graph.set(dependency.dependsOnAssignmentId, []);
  }
  return graph;
}

function visit(
  node: string,
  graph: ReadonlyMap<string, readonly string[]>,
  visited: Set<string>,
  active: Set<string>,
  path: string[],
): string[] | null {
  if (active.has(node)) return cycleFrom(path, node);
  if (visited.has(node)) return null;
  active.add(node);
  path.push(node);
  for (const dependency of graph.get(node) ?? []) {
    const cycle = visit(dependency, graph, visited, active, path);
    if (cycle) return cycle;
  }
  path.pop();
  active.delete(node);
  visited.add(node);
  return null;
}

function cycleFrom(path: readonly string[], node: string): string[] {
  const start = path.lastIndexOf(node);
  return [...path.slice(start), node];
}

/**
 * Graph validation — everything the engine must never be handed. Runs before
 * compilation and before RUN. Messages are operator-readable, not "invalid
 * numeric value".
 */

import type { ScenarioGraph } from './graph';

export interface GraphIssue {
  severity: 'error' | 'warning';
  message: string;
  /** Graph object the issue points at, when applicable. */
  ref?: string;
}

export interface GraphValidation {
  ok: boolean;
  issues: GraphIssue[];
}

/** Nodes reachable from `originId` following available edges. */
export function reachableFrom(graph: ScenarioGraph, originId: string): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!e.available) continue;
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const seen = new Set<string>([originId]);
  const stack = [originId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

export function validateGraph(graph: ScenarioGraph): GraphValidation {
  const issues: GraphIssue[] = [];
  const err = (message: string, ref?: string) =>
    issues.push({ severity: 'error', message, ref });
  const warn = (message: string, ref?: string) =>
    issues.push({ severity: 'warning', message, ref });

  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgeIds = new Set(graph.edges.map((e) => e.id));
  const resourceIds = new Set(graph.resources.map((r) => r.id));

  /* --- structure --- */
  if (graph.nodes.length === 0) err('Add at least one node to the network.');
  if (graph.durationMinutes <= 0) err('Simulation duration must be greater than zero.');
  if (graph.timestepMinutes <= 0) err('Timestep must be greater than zero.');

  const dupNodeIds = graph.nodes.map((n) => n.id).filter((id, i, a) => a.indexOf(id) !== i);
  for (const id of new Set(dupNodeIds)) err(`Duplicate node id "${id}".`, id);

  /* --- edges --- */
  for (const e of graph.edges) {
    const label = `Route ${e.id}`;
    if (!nodeIds.has(e.from)) err(`${label} starts at a node that no longer exists.`, e.id);
    if (!nodeIds.has(e.to)) err(`${label} ends at a node that no longer exists.`, e.id);
    if (e.from === e.to) err(`${label} connects a node to itself.`, e.id);
    if (e.travelTimeMinutes <= 0) err(`${label} travel time must be greater than zero.`, e.id);
    if (e.capacity < 0) err(`${label} capacity cannot be negative.`, e.id);
    if (e.cost < 0) err(`${label} cost cannot be negative.`, e.id);
  }
  const dupEdge = graph.edges
    .map((e) => `${e.from}->${e.to}`)
    .filter((k, i, a) => a.indexOf(k) !== i);
  for (const k of new Set(dupEdge)) warn(`More than one route runs ${k.replace('->', ' → ')}.`);

  /* --- resources --- */
  for (const r of graph.resources) {
    if (r.quantity < 0) err(`Resource "${r.label}" quantity cannot be negative.`, r.id);
    if (r.unitCost < 0) err(`Resource "${r.label}" unit cost cannot be negative.`, r.id);
  }

  /* --- shipments --- */
  if (graph.shipments.length === 0) warn('No shipments defined — nothing will move.');
  for (const s of graph.shipments) {
    if (!nodeIds.has(s.originId)) err(`Shipment ${s.label} has no valid origin.`, s.id);
    if (!nodeIds.has(s.destinationId)) err(`Shipment ${s.label} has no valid destination.`, s.id);
    if (s.quantity <= 0) err(`Shipment ${s.label} quantity must be greater than zero.`, s.id);
    if (nodeIds.has(s.originId) && nodeIds.has(s.destinationId)) {
      const reach = reachableFrom(graph, s.originId);
      if (!reach.has(s.destinationId)) {
        err(`Shipment ${s.label} has no reachable route to its destination.`, s.id);
      }
    }
  }

  /* --- incidents --- */
  for (const inc of graph.incidents) {
    if (inc.atMinutes < 0) err('Incident time cannot be negative.', inc.id);
    if (inc.type === 'route-blockage') {
      if (!inc.targetId || !edgeIds.has(inc.targetId)) {
        err('Route-blockage incident must target an existing route.', inc.id);
      }
    }
    if (inc.type === 'resource-unavailable') {
      if (!inc.targetId || !resourceIds.has(inc.targetId)) {
        err('Resource incident must target an existing resource.', inc.id);
      }
    }
    if (inc.type === 'storage-reduction') {
      if (!inc.targetId || !nodeIds.has(inc.targetId)) {
        err('Storage-reduction incident must target an existing storage node.', inc.id);
      }
    }
  }

  /* --- cascades --- */
  for (const c of graph.cascades) {
    if (c.delayMinutes < 0) err('Cascade delay cannot be negative.', c.id);
    for (const eff of c.emit.blocksRoutes ?? []) {
      if (!edgeIds.has(eff)) err(`Cascade "${c.id}" blocks a route that does not exist.`, c.id);
    }
    for (const cond of c.conditions) {
      if (cond.kind === 'resourceAvailable' && !resourceIds.has(cond.resourceId)) {
        err(`Cascade "${c.id}" references a resource that does not exist.`, c.id);
      }
    }
  }

  /* --- constraints --- */
  for (const con of graph.constraints) {
    if (con.scope === 'static' && con.metric !== 'cost') {
      warn(`Constraint on ${con.metric} is usually trajectory or final, not static.`, con.id);
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

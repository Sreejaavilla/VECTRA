/**
 * Bounded path enumeration over a ScenarioGraph. Pure graph theory — no
 * simulation, no domain calculation. Deterministic ordering.
 */

import type { ScenarioGraph } from './graph';

export interface GraphPath {
  /** Node ids, origin first, destination last. */
  nodes: string[];
  /** Edge ids along the path, in order. */
  edges: string[];
  travelTimeMinutes: number;
  cost: number;
}

const MAX_PATHS = 4;
const MAX_HOPS = 7;

/**
 * Up to `MAX_PATHS` simple paths from `originId` to `destinationId`, shortest
 * total travel time first. Only traverses available edges.
 */
export function enumeratePaths(
  graph: ScenarioGraph,
  originId: string,
  destinationId: string,
): GraphPath[] {
  const outgoing = new Map<string, ScenarioGraph['edges']>();
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!e.available) continue;
    if (!outgoing.has(e.from)) outgoing.set(e.from, []);
    outgoing.get(e.from)!.push(e);
  }

  const found: GraphPath[] = [];
  const walk = (
    node: string,
    visited: Set<string>,
    nodeAcc: string[],
    edgeAcc: string[],
    time: number,
    cost: number,
  ) => {
    if (found.length >= MAX_PATHS * 4) return; // hard cap on exploration
    if (node === destinationId) {
      found.push({ nodes: [...nodeAcc], edges: [...edgeAcc], travelTimeMinutes: time, cost });
      return;
    }
    if (nodeAcc.length > MAX_HOPS) return;
    for (const e of outgoing.get(node) ?? []) {
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      walk(
        e.to,
        visited,
        [...nodeAcc, e.to],
        [...edgeAcc, e.id],
        time + e.travelTimeMinutes,
        cost + e.cost,
      );
      visited.delete(e.to);
    }
  };

  walk(originId, new Set([originId]), [originId], [], 0, 0);

  found.sort(
    (a, b) =>
      a.travelTimeMinutes - b.travelTimeMinutes ||
      a.edges.length - b.edges.length ||
      a.edges.join().localeCompare(b.edges.join()),
  );
  // Deduplicate identical edge sequences, keep the first MAX_PATHS.
  const seen = new Set<string>();
  const unique: GraphPath[] = [];
  for (const p of found) {
    const key = p.edges.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
    if (unique.length >= MAX_PATHS) break;
  }
  return unique;
}

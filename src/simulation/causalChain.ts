/**
 * Causal chain (Checkpoint 4).
 *
 * Turns a finished run into an ordered CAUSE -> EFFECT -> CONSEQUENCE -> DECISION
 * chain built from real event links — `causedBy`, cascade provenance
 * (`event.cascade`), and event class — never from parsing message strings.
 *
 * Every node carries `sourceId` / `affectedId` so the map can highlight the
 * actual object a step refers to (a route, a shipment, the contested resource).
 */

import type { EventSeverity, SimulationEvent } from '../domain';
import { resolveEventClass } from '../domain';
import type { SimulationResult } from './types';

export type CausalNodeKind = 'incident' | 'cascade' | 'consequence' | 'decision';

export interface CausalNode {
  /** The event id this node is derived from. */
  id: string;
  kind: CausalNodeKind;
  label: string;
  timestamp: number;
  severity?: EventSeverity;
  /** Upstream event id, when the link is explicit. */
  causeId?: string;
  /** Object the trigger/incident observed — route, entity, resource or metric id. */
  sourceId?: string;
  /** Object the effect changed — entity or route id. */
  affectedId?: string;
  /** Cascade rule id, for the technical inspector. */
  ruleId?: string;
}

const INCIDENT_TYPES = new Set(['FAILURE']);
const CONSEQUENCE_TYPES = new Set([
  'INTERCEPTION',
  'RECOVERY',
  'REROUTE',
  'STORAGE_TRANSFER',
  'DELIVERY',
  'VEHICLE_DISPATCHED',
]);

function classify(event: SimulationEvent): CausalNodeKind | null {
  if (event.cascade) return 'cascade';
  if (resolveEventClass(event) === 'decision') return 'decision';
  if (INCIDENT_TYPES.has(event.type)) return 'incident';
  if (event.type === 'CONSTRAINT_VIOLATED' || event.type === 'THRESHOLD_CROSSED') return 'incident';
  if (CONSEQUENCE_TYPES.has(event.type)) return 'consequence';
  return null;
}

/**
 * Build the causal chain. Nodes are ordered by time; each node's `causeId`
 * points at the event that produced it — the explicit link where one exists,
 * otherwise the most recent upstream incident / cascade node.
 */
export function buildCausalChain(result: SimulationResult): CausalNode[] {
  const ordered = [...result.events].sort(
    (a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id),
  );

  const nodes: CausalNode[] = [];
  let lastUpstreamId: string | undefined;

  for (const event of ordered) {
    const kind = classify(event);
    if (!kind) continue;

    const explicitCause = event.causedBy ?? event.cascade?.causeEventId;
    const causeId =
      explicitCause && nodes.some((n) => n.id === explicitCause)
        ? explicitCause
        : kind === 'incident'
          ? undefined
          : lastUpstreamId;

    nodes.push({
      id: event.id,
      kind,
      label: event.message,
      timestamp: event.timestamp,
      severity: event.severity,
      causeId,
      sourceId: event.cascade?.sourceId ?? event.routeId ?? event.resourceId ?? event.entityId,
      affectedId: event.cascade?.affectedId ?? event.focusEntityId ?? event.entityId,
      ruleId: event.cascade?.ruleId,
    });

    if (kind === 'incident' || kind === 'cascade') lastUpstreamId = event.id;
  }

  return nodes;
}

/**
 * The single most consequential path through the chain: walk back from the
 * decision (or the last node) following `causeId`. This is the "ROOT INCIDENT
 * -> … -> DECISION REQUIRED" spine the judge-facing view shows.
 */
export function primaryCausalPath(nodes: CausalNode[]): CausalNode[] {
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const tail = [...nodes].reverse().find((n) => n.kind === 'decision') ?? nodes[nodes.length - 1];

  const path: CausalNode[] = [];
  let cursor: CausalNode | undefined = tail;
  const guard = new Set<string>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    path.unshift(cursor);
    cursor = cursor.causeId ? byId.get(cursor.causeId) : undefined;
  }
  return path;
}

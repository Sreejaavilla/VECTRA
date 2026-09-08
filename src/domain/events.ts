/**
 * Events are the authoritative record of what happened during a run. Every
 * event carries a stable id and a single timestamp in simulation minutes.
 */

export type SimulationEventType =
  | 'FAILURE'
  | 'RESOURCE_ALLOCATED'
  | 'VEHICLE_DISPATCHED'
  | 'INTERCEPTION'
  | 'STORAGE_TRANSFER'
  | 'REROUTE'
  | 'THRESHOLD_CROSSED'
  | 'CONSTRAINT_VIOLATED'
  | 'DELIVERY'
  | 'RECOVERY'
  | 'DECISION'
  | (string & {});

/**
 * System events describe what happened TO the system; decision events describe
 * what the decision-maker DID. The timeline renders them differently.
 */
export type EventClass = 'system' | 'decision';

/** Event types that are decisions/interventions when `eventClass` is not set explicitly. */
export const DECISION_TYPES: readonly string[] = [
  'DECISION',
  'VEHICLE_DISPATCHED',
  'REROUTE',
  'STORAGE_TRANSFER',
  'RESOURCE_ALLOCATED',
];

export type EventSeverity = 'info' | 'warning' | 'critical';

export interface SimulationEvent {
  id: string;
  /** Simulation minutes from t0. */
  timestamp: number;
  type: SimulationEventType;
  /** Engine may set explicitly; otherwise derived from `type` via DECISION_TYPES. */
  eventClass?: EventClass;
  entityId?: string;
  resourceId?: string;
  facilityId?: string;
  routeId?: string;
  /** Id of the event that caused this one, when the relationship is explicit. */
  causedBy?: string;
  message: string;
  severity?: EventSeverity;
  /** Hint: which entity the view should emphasize when this event fires. */
  focusEntityId?: string;
}

export function isDecisionType(type: string): boolean {
  return DECISION_TYPES.includes(type);
}

/** Resolve an event's class, falling back to the type table. */
export function resolveEventClass(event: SimulationEvent): EventClass {
  return event.eventClass ?? (isDecisionType(event.type) ? 'decision' : 'system');
}

/**
 * Sort ascending by timestamp and drop duplicate ids. Ties break on id so the
 * ordering is stable and therefore deterministic.
 */
export function normalizeEventLog(events: readonly SimulationEvent[]): SimulationEvent[] {
  const seen = new Set<string>();
  const unique: SimulationEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    unique.push(event);
  }
  unique.sort((a, b) => (a.timestamp - b.timestamp) || a.id.localeCompare(b.id));
  return unique;
}

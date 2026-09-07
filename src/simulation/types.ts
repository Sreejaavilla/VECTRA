/**
 * CAUSALIS / VECTRA — Simulation data contract (integration boundary).
 *
 * This is the interface the simulation engine must eventually produce. The
 * visualization layer consumes `SimulationResult` and never computes domain
 * metrics (temperature, viability, scoring, feasibility) itself.
 *
 * Identity rule: entities, routes, facilities, resources and events are ALWAYS
 * referenced by stable string id — never by array index, position or timestamp.
 */

/** Abstract map coordinate. The operational map uses a 0..100 (x) by 0..60 (y) space. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Optional utilization state the map renders when present. */
export interface Capacity {
  capacity: number;
  used: number;
  unit?: string;
}

export type FacilityKind = 'hub' | 'destination' | 'storage' | (string & {});

export interface Facility {
  id: string;
  kind: FacilityKind;
  label: string;
  position: Vec2;
  /** Cold-storage used/total, hospital received/demand, etc. */
  capacity?: Capacity;
  /** Priority, ETA and other display-only annotations. */
  meta?: Record<string, string | number>;
}

export type RouteKind = 'primary' | 'emergency' | 'reroute' | (string & {});

export interface Route {
  id: string;
  from: string;
  to: string;
  /** Optional polyline; a straight line between endpoints is used when absent. */
  waypoints?: Vec2[];
  kind?: RouteKind;
  capacity?: Capacity;
  blocked?: boolean;
}

export type EntityKind = 'shipment_vehicle' | 'support_vehicle' | (string & {});

export interface EntityState {
  id: string;
  kind: EntityKind;
  label: string;
  /** Route the entity is currently travelling. */
  routeId: string | null;
  /** 0..1 along `routeId`. */
  progress: number;
  /** Explicit position override (e.g. staged off-route). Wins over route+progress. */
  position?: Vec2;
  /**
   * e.g. 'en_route' | 'refrigeration_failed' | 'intercepted' | 'delivering'
   * | 'delivered' | 'idle' | 'dispatched'
   */
  status: string;
  /** Whether the entity is drawn on the map at all. */
  active: boolean;
}

export type ResourceStatus = 'available' | 'allocated' | 'depleted' | 'unavailable';

export interface ResourceState {
  id: string;
  label: string;
  status: ResourceStatus;
  /** "4,200 / 5,000 capacity", "₹3.2L remaining", etc. */
  detail?: string;
}

export type SimulationEventType =
  | 'FAILURE'
  | 'RESOURCE_ALLOCATED'
  | 'VEHICLE_DISPATCHED'
  | 'INTERCEPTION'
  | 'STORAGE_TRANSFER'
  | 'REROUTE'
  | 'THRESHOLD_CROSSED'
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
  message: string;
  severity?: EventSeverity;
  /** Hint: which entity the view should emphasize when this event fires. */
  focusEntityId?: string;
}

export interface StepMetrics {
  temperature?: number;
  viability?: number;
  cost?: number;
  delay?: number;
  risk?: number;
}

export type MetricKey = keyof StepMetrics;

export interface SimulationStep {
  /** Simulation minutes, ascending. Step 0 is t0. */
  timestamp: number;
  entities: EntityState[];
  resources: ResourceState[];
  metrics: StepMetrics;
  /** Events occurring at (or just before) this step. */
  events: SimulationEvent[];
}

export interface MetricThresholds {
  safe?: number;
  critical?: number;
  min?: number;
  max?: number;
}

export interface ScenarioConfig {
  id: string;
  title: string;
  facilities: Facility[];
  routes: Route[];
  metricThresholds: Partial<Record<MetricKey, MetricThresholds>>;
  metricUnits?: Partial<Record<MetricKey, string>>;
}

/** From the analytics layer. Weights are 0..1. */
export interface SensitivityDriver {
  label: string;
  weight: number;
}

/** From the analytics layer. Scores are -1..2 (⚠ = -1..0, ✓ = 1, ✓✓ = 2). */
export interface TradeoffRow {
  strategy: string;
  scores: Record<string, number>;
}

export interface SimulationOutcome {
  strategy: string;
  status: 'success' | 'partial' | 'failed';
  summary: string;
  finalMetrics: StepMetrics;
}

/** Identity + inputs for a run. Makes comparison and deterministic replay clean. */
export interface RunIdentity {
  runId: string;
  runNumber: number;
  label: string;
  /** Echoed configuration: safetyPriority, budget, etc. */
  inputs: Record<string, string | number>;
  /** Deterministic: same seed + inputs => identical result. */
  seed: number;
}

/**
 * Snapshot of decision impact: state at the first decision event vs the
 * projected final state. Drives the "before vs after" panel.
 */
export interface DecisionImpact {
  decisionEventId: string;
  before: StepMetrics;
  projected: StepMetrics;
  riskBefore?: string;
  riskAfter?: string;
}

export interface SimulationResult {
  run: RunIdentity;
  scenario: ScenarioConfig;
  /** Action that was simulated. */
  strategy: string;
  /** Total simulation minutes. */
  duration: number;
  steps: SimulationStep[];
  /** Flattened, sorted; a superset of the per-step events. */
  events: SimulationEvent[];
  outcome: SimulationOutcome;
  decisionImpact?: DecisionImpact;
  sensitivity?: SensitivityDriver[];
  tradeoffs?: TradeoffRow[];
}

/** Narrative summary of the run at a point in time. NOT authoritative state. */
export type NarrativePhase =
  | 'NORMAL'
  | 'FAILURE'
  | 'DETERIORATING'
  | 'INTERVENTION'
  | 'RECOVERY'
  | 'DELIVERY';

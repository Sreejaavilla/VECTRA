/**
 * A scenario is the immutable environment: what exists, what is allowed, what
 * can be done and what we are trying to achieve. A run derives state from it;
 * a run never mutates it.
 */

import type { ActionDefinition } from './action';
import type { ConstraintDefinition } from './constraint';
import type { EntityKind, Facility, Route } from './entity';
import type { EventClass, EventSeverity, SimulationEventType } from './events';
import type { MetricDefinition, MetricKey, MetricThresholds } from './metric';
import type { StepModel } from './model';
import type { ObjectiveDefinition } from './objective';
import type { ResourceDefinition } from './resource';

export interface SimulationConfig {
  timestepMinutes: number;
  durationMinutes: number;
}

export interface EntitySeed {
  id: string;
  kind: EntityKind;
  label: string;
  routeId: string | null;
  progress: number;
  status: string;
  active: boolean;
  /** Doses carried, keyed by destination facility id. */
  payload?: Record<string, number>;
  refrigerated?: boolean;
  coolingEfficiency?: number;
}

export interface InitialStateConfig {
  entities: EntitySeed[];
  /** Destination facility id -> doses required. */
  shipmentAllocations: Record<string, number>;
  /** Cargo temperature every shipment starts at. */
  initialCargoTemperature: number;
  flags?: Record<string, boolean | number | string>;
}

/**
 * Exogenous events the scenario schedules regardless of which action is taken —
 * the refrigeration failure itself. Config, not engine logic, so a different
 * domain does not inherit cold-chain assumptions.
 */
export interface ScheduledEvent {
  id: string;
  atMinutes: number;
  type: SimulationEventType;
  eventClass: EventClass;
  message: string;
  severity?: EventSeverity;
  entityId?: string;
  routeId?: string;
  focusEntityId?: string;
  /** Flags to set when this event fires. */
  setFlags?: Record<string, boolean | number | string>;
  /** Entity ids whose refrigeration this event breaks. */
  breaksRefrigeration?: string[];
  /**
   * Route ids this event makes impassable from `atMinutes` onward. An entity
   * already on a blocked route halts in place until it is diverted; the delay
   * metric keeps accruing and the cargo keeps warming, which is the whole point.
   */
  blocksRoutes?: string[];
}

/* --------------------------------------------------------------------------- *
 * Cascades — declarative consequence rules. The engine evaluates them inside
 * the existing simulation loop; they are NOT a parallel simulator. A rule is
 *
 *   TRIGGER -> (CONDITIONS) -> DELAY -> STATE EFFECT -> NEW EVENT
 *
 * and every step it produces is a real state mutation and/or a real event.
 * --------------------------------------------------------------------------- */

export type CascadeTriggerKind = 'time' | 'event' | 'metric' | 'state' | 'resource';

export interface CascadeTrigger {
  kind: CascadeTriggerKind;
  /** kind:'time' — fire at this minute (crossing semantics). */
  atMinutes?: number;
  /** kind:'event' — fire when an event of this type is emitted. */
  eventType?: SimulationEventType;
  /** kind:'metric' — the metric key to watch. */
  metric?: MetricKey | string;
  /** kind:'state' — the flag to watch (numeric flags only for comparison). */
  flag?: string;
  /** kind:'metric'|'state' — comparison against `threshold`. */
  operator?: '<' | '<=' | '>' | '>=' | '=';
  threshold?: number;
  /** kind:'resource' — the resource to watch. */
  resourceId?: string;
  resourceStatus?: 'available' | 'unavailable' | 'depleted' | 'allocated';
  /** Optional additional flag gate (must be truthy/non-zero for the rule to fire). */
  whenFlag?: string;
}

export interface CascadeEffect {
  setFlags?: Record<string, boolean | number | string>;
  breaksRefrigeration?: string[];
  blocksRoutes?: string[];
  /** Additive nudge to a live metric (e.g. delivery pressure raising `delay`). */
  adjustMetric?: { metric: MetricKey | string; delta: number };
}

export interface CascadeEmit {
  type: SimulationEventType;
  eventClass: EventClass;
  message: string;
  severity?: EventSeverity;
  entityId?: string;
  routeId?: string;
  resourceId?: string;
  focusEntityId?: string;
}

export interface CascadeRule {
  id: string;
  /** Short label for causal-chain display. */
  label: string;
  trigger: CascadeTrigger;
  /** Minutes to wait after the trigger before applying effect/emit. */
  delayMinutes?: number;
  /** Fire at most once. Default true. A false value re-arms on threshold re-crossing. */
  once?: boolean;
  effect?: CascadeEffect;
  emit?: CascadeEmit;
  /** Id of the object the trigger observes — provenance only. */
  sourceId?: string;
  /** Id of the object the effect changes — provenance only. */
  affectedId?: string;
}

export interface ScenarioConfig {
  id: string;
  version: number;
  title: string;

  /* --- spatial (consumed directly by the operational map) --- */
  facilities: Facility[];
  routes: Route[];

  /* --- display thresholds for the charts --- */
  metricThresholds: Partial<Record<MetricKey, MetricThresholds>>;
  metricUnits?: Partial<Record<MetricKey, string>>;

  /* --- decision model --- */
  metrics: MetricDefinition[];
  resources: ResourceDefinition[];
  constraints: ConstraintDefinition[];
  objectives: ObjectiveDefinition[];
  actions: ActionDefinition[];

  /* --- dynamics --- */
  initialState: InitialStateConfig;
  scheduledEvents: ScheduledEvent[];
  /** Declarative cascade rules, evaluated inside the main simulation loop. */
  cascadeRules?: CascadeRule[];
  stepModels: StepModel[];
  simulation: SimulationConfig;
}

export function findAction(
  scenario: ScenarioConfig,
  id: string,
): ActionDefinition | undefined {
  return scenario.actions.find((a) => a.id === id);
}

export function findRoute(scenario: ScenarioConfig, id: string): Route | undefined {
  return scenario.routes.find((r) => r.id === id);
}

export function findFacility(scenario: ScenarioConfig, id: string): Facility | undefined {
  return scenario.facilities.find((f) => f.id === id);
}

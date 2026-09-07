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
  focusEntityId?: string;
  /** Flags to set when this event fires. */
  setFlags?: Record<string, boolean | number | string>;
  /** Entity ids whose refrigeration this event breaks. */
  breaksRefrigeration?: string[];
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

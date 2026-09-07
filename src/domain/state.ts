/**
 * The authoritative simulation state: the complete representation of the system
 * at one simulation time.
 *
 * Keyed by stable id, never positional. The render-facing arrays
 * (`EntityState[]`, `ResourceState[]`) are DERIVED from this in the adapter and
 * are never stored back here.
 */

import type { Capacity, EntityKind, FacilityKind } from './entity';
import type { ResourceKind, ResourceStatus } from './resource';
import type { StepMetrics } from './metric';

export interface EntityRuntime {
  id: string;
  kind: EntityKind;
  label: string;
  /** Authoritative location: route + progress. */
  routeId: string | null;
  progress: number;
  status: string;
  active: boolean;
  /** Doses carried, keyed by destination facility id. Enables shipment splitting. */
  payload: Record<string, number>;
  /** Whether this entity's cargo currently has working refrigeration. */
  refrigerated: boolean;
  /**
   * How effective that refrigeration is, 0..1. A support vehicle asked to
   * re-cool more cargo than it is rated for restores temperature slowly; the
   * same vehicle handling only the portion it can take restores it fully.
   * This is what makes splitting a shipment beat rescuing all of it at once.
   */
  coolingEfficiency: number;
  /** Temperature of the cargo this entity is carrying. */
  cargoTemperature: number;
  /** Degree-minutes this entity's cargo has spent above the safe temperature. */
  cargoExposure: number;
}

/**
 * A portion of the shipment that has reached its resting place — delivered to a
 * hospital or parked in cold storage. Its exposure is frozen at that moment,
 * which is exactly why splitting a shipment can beat keeping it together.
 */
export interface SettledPortion {
  destinationId: string;
  doses: number;
  exposure: number;
  atMinutes: number;
  kind: 'delivered' | 'stored';
}

export interface FacilityRuntime {
  id: string;
  kind: FacilityKind;
  status: string;
  capacity?: Capacity;
  /** Doses delivered here so far. */
  received: number;
}

export interface ResourceRuntime {
  id: string;
  label: string;
  kind: ResourceKind;
  status: ResourceStatus;
  quantity: number;
  capacity?: number;
  unitCost?: number;
  unit?: string;
}

export interface SimulationState {
  timestamp: number;
  entities: Record<string, EntityRuntime>;
  facilities: Record<string, FacilityRuntime>;
  resources: Record<string, ResourceRuntime>;
  /** Destination facility id -> doses still owed. Drives multi-destination + hybrid. */
  shipmentAllocations: Record<string, number>;
  /** Portions that have come to rest, with their exposure frozen. */
  settled: SettledPortion[];
  /** Dose-weighted mean exposure across the whole shipment. */
  exposure: number;
  metrics: StepMetrics;
  flags: Record<string, boolean | number | string>;
}

/** Structural clone of a state. The loop never mutates a state it has emitted. */
export function cloneState(state: SimulationState): SimulationState {
  const entities: Record<string, EntityRuntime> = {};
  for (const key of Object.keys(state.entities)) {
    const entity = state.entities[key];
    entities[key] = { ...entity, payload: { ...entity.payload } };
  }
  const facilities: Record<string, FacilityRuntime> = {};
  for (const key of Object.keys(state.facilities)) {
    const facility = state.facilities[key];
    facilities[key] = {
      ...facility,
      capacity: facility.capacity ? { ...facility.capacity } : undefined,
    };
  }
  const resources: Record<string, ResourceRuntime> = {};
  for (const key of Object.keys(state.resources)) {
    resources[key] = { ...state.resources[key] };
  }
  return {
    timestamp: state.timestamp,
    entities,
    facilities,
    resources,
    shipmentAllocations: { ...state.shipmentAllocations },
    settled: state.settled.map((portion) => ({ ...portion })),
    exposure: state.exposure,
    metrics: { ...state.metrics },
    flags: { ...state.flags },
  };
}

/** Every portion of the shipment with its current exposure — in flight or settled. */
export function shipmentPortions(
  state: SimulationState,
): Array<{ doses: number; exposure: number }> {
  const portions: Array<{ doses: number; exposure: number }> = [];
  for (const key of Object.keys(state.entities).sort()) {
    const entity = state.entities[key];
    const doses = Object.keys(entity.payload).reduce(
      (total, dest) => total + entity.payload[dest],
      0,
    );
    if (doses > 0) portions.push({ doses, exposure: entity.cargoExposure });
  }
  for (const portion of state.settled) {
    if (portion.doses > 0) portions.push({ doses: portion.doses, exposure: portion.exposure });
  }
  return portions;
}

/** Total doses still undelivered across all destinations. */
export function outstandingDoses(state: SimulationState): number {
  return Object.keys(state.shipmentAllocations).reduce(
    (total, key) => total + state.shipmentAllocations[key],
    0,
  );
}

/**
 * The discrete-timestep loop. Domain-agnostic: it knows how to advance time,
 * move entities along routes, fire scheduled and action-driven transitions, run
 * whatever step models the scenario supplies, and freeze an immutable snapshot
 * per step. It does not know what a temperature is.
 *
 * Every snapshot is produced once and never touched again — that is what makes
 * replay, seeking, comparison and analytics safe.
 */

import type {
  ActionContext,
  ActionDefinition,
  ActionEventTemplate,
  ScenarioConfig,
  SimulationEvent,
  SimulationInputs,
  SimulationState,
} from '../domain';
import {
  cloneState,
  initialQuantity,
  interpolatePosition,
  normalizeEventLog,
  routePolyline,
} from '../domain';
import { applyTransition, switchRoute, type TransitionEnv } from './transitions';
import { mulberry32 } from './rng';

export interface TrajectoryFrame {
  /** Frozen state at this step. */
  state: SimulationState;
  /** Events in the interval (previousFrame.timestamp, this.timestamp]. */
  events: SimulationEvent[];
}

export interface Trajectory {
  frames: TrajectoryFrame[];
  events: SimulationEvent[];
}

const DEFAULT_TRAVEL_MINUTES = 60;

export function buildInitialState(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
): SimulationState {
  const state: SimulationState = {
    timestamp: 0,
    entities: {},
    facilities: {},
    resources: {},
    shipmentAllocations: { ...scenario.initialState.shipmentAllocations },
    settled: [],
    exposure: 0,
    metrics: {},
    flags: { ...(scenario.initialState.flags ?? {}) },
  };

  for (const seed of scenario.initialState.entities) {
    state.entities[seed.id] = {
      id: seed.id,
      kind: seed.kind,
      label: seed.label,
      routeId: seed.routeId,
      progress: seed.progress,
      status: seed.status,
      active: seed.active,
      payload: { ...(seed.payload ?? {}) },
      refrigerated: seed.refrigerated ?? true,
      coolingEfficiency: seed.coolingEfficiency ?? 1,
      cargoTemperature: scenario.initialState.initialCargoTemperature,
      cargoExposure: 0,
    };
  }

  for (const facility of scenario.facilities) {
    state.facilities[facility.id] = {
      id: facility.id,
      kind: facility.kind,
      status: 'nominal',
      capacity: facility.capacity ? { ...facility.capacity } : undefined,
      received: 0,
    };
  }

  for (const definition of scenario.resources) {
    const override = inputs.resources[definition.id];
    const quantity =
      override === undefined
        ? initialQuantity(definition)
        : typeof override === 'boolean'
          ? override
            ? 1
            : 0
          : override;
    state.resources[definition.id] = {
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      status: quantity > 0 ? 'available' : 'unavailable',
      quantity,
      capacity: definition.capacity,
      unitCost: definition.unitCost,
      unit: definition.unit,
    };
  }

  return state;
}

function travelMinutes(scenario: ScenarioConfig, routeId: string | null): number {
  if (!routeId) return DEFAULT_TRAVEL_MINUTES;
  const route = scenario.routes.find((r) => r.id === routeId);
  return route?.travelTimeMinutes ?? DEFAULT_TRAVEL_MINUTES;
}

/**
 * Advance every active entity along its route and settle any payload that has
 * reached its addressed destination. Delivery-on-arrival is generic: an entity
 * arriving at a facility hands over the portion addressed to that facility.
 */
function advanceEntities(
  scenario: ScenarioConfig,
  state: SimulationState,
  now: number,
  dt: number,
  env: TransitionEnv,
  emit: (event: SimulationEvent) => void,
): void {
  for (const key of Object.keys(state.entities).sort()) {
    const entity = state.entities[key];
    if (!entity.active || !entity.routeId || dt <= 0) continue;
    if (entity.progress >= 1) continue;

    const duration = travelMinutes(scenario, entity.routeId);
    entity.progress = Math.min(1, entity.progress + dt / Math.max(1e-6, duration));
    if (entity.progress < 1) continue;

    /* --- arrival --- */
    const route = scenario.routes.find((r) => r.id === entity.routeId);
    if (!route) continue;
    const destination = route.to;
    const doses = entity.payload[destination] ?? 0;

    if (doses > 0) {
      const facility = state.facilities[destination];
      if (facility) {
        facility.received += doses;
        if (facility.capacity) {
          facility.capacity.used = Math.min(
            facility.capacity.capacity,
            facility.capacity.used + doses,
          );
        }
      }
      state.settled.push({
        destinationId: destination,
        doses,
        exposure: entity.cargoExposure,
        atMinutes: now,
        kind: 'delivered',
      });
      state.shipmentAllocations[destination] = Math.max(
        0,
        (state.shipmentAllocations[destination] ?? 0) - doses,
      );
      delete entity.payload[destination];

      emit({
        id: `event-delivery-${destination}`,
        timestamp: now,
        type: 'DELIVERY',
        eventClass: 'system',
        entityId: entity.id,
        facilityId: destination,
        message: `${doses.toLocaleString()} doses delivered to ${
          scenario.facilities.find((f) => f.id === destination)?.label ?? destination
        }`,
        severity: 'info',
        focusEntityId: entity.id,
      });
    }

    const remaining = Object.keys(entity.payload).reduce(
      (total, dest) => total + entity.payload[dest],
      0,
    );

    // Chained legs: an entity still carrying payload rolls onto the next route.
    if (remaining > 0 && route.continuesTo) {
      switchRoute(state, entity.id, route.continuesTo, env);
      entity.progress = 0;
      entity.status = 'en_route';
      continue;
    }

    if (remaining <= 0) {
      entity.status = 'delivered';
    }
  }
}

/** Position of an entity in world space — used for route-switch continuity. */
export function entityPosition(
  scenario: ScenarioConfig,
  state: SimulationState,
  entityId: string,
): { x: number; y: number } {
  const entity = state.entities[entityId];
  if (!entity || !entity.routeId) return { x: 0, y: 0 };
  const route = scenario.routes.find((r) => r.id === entity.routeId);
  if (!route) return { x: 0, y: 0 };
  return interpolatePosition(routePolyline(route, scenario.facilities), entity.progress);
}

export function simulateTrajectory(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  action: ActionDefinition,
  seed: number,
): Trajectory {
  const { timestepMinutes, durationMinutes } = scenario.simulation;
  const env: TransitionEnv = { routes: scenario.routes, facilities: scenario.facilities };
  const random = mulberry32(seed);

  const state = buildInitialState(scenario, inputs);
  const frames: TrajectoryFrame[] = [];
  const allEvents: SimulationEvent[] = [];

  const scheduled = [...scenario.scheduledEvents].sort(
    (a, b) => a.atMinutes - b.atMinutes || a.id.localeCompare(b.id),
  );
  const actionEvents = [...action.emittedEvents].sort(
    (a, b) => a.atOffsetMinutes - b.atOffsetMinutes || a.id.localeCompare(b.id),
  );
  const actionTransitions = [...action.transitions];

  const firedScheduled = new Set<string>();
  const firedActionEvents = new Set<string>();
  const firedTransitions = new Set<number>();
  const crossedConstraints = new Set<string>();
  let emitCounter = 0;

  const decisionTime = action.decisionTimeMinutes;

  for (let index = 0; ; index += 1) {
    const now = Math.min(index * timestepMinutes, durationMinutes);
    const previous = index === 0 ? -Infinity : (index - 1) * timestepMinutes;
    const dt = index === 0 ? 0 : now - (index - 1) * timestepMinutes;
    const stepEvents: SimulationEvent[] = [];
    const emit = (event: SimulationEvent) => {
      stepEvents.push(event);
      allEvents.push(event);
    };

    state.timestamp = now;

    /* --- 1. exogenous scenario events (the refrigeration failure itself) --- */
    for (const event of scheduled) {
      if (firedScheduled.has(event.id)) continue;
      if (event.atMinutes > now + 1e-9 || event.atMinutes <= previous) continue;
      firedScheduled.add(event.id);
      if (event.setFlags) {
        for (const key of Object.keys(event.setFlags)) state.flags[key] = event.setFlags[key];
      }
      for (const entityId of event.breaksRefrigeration ?? []) {
        const entity = state.entities[entityId];
        if (entity) {
          entity.refrigerated = false;
          entity.status = 'refrigeration_failed';
        }
      }
      emit({
        id: event.id,
        timestamp: event.atMinutes,
        type: event.type,
        eventClass: event.eventClass,
        entityId: event.entityId,
        message: event.message,
        severity: event.severity,
        focusEntityId: event.focusEntityId ?? event.entityId,
      });
    }

    /* --- 2. declarative action transitions scheduled off the decision time --- */
    actionTransitions.forEach((transition, position) => {
      if (firedTransitions.has(position)) return;
      const at = decisionTime + (transition.atOffsetMinutes ?? 0);
      if (at > now + 1e-9 || at <= previous) return;
      firedTransitions.add(position);
      applyTransition(state, transition, env);
    });

    /* --- 3. action events --- */
    for (const template of actionEvents) {
      if (firedActionEvents.has(template.id)) continue;
      const at = decisionTime + template.atOffsetMinutes;
      if (at > now + 1e-9 || at <= previous) continue;
      firedActionEvents.add(template.id);
      emit(toEvent(template, action.id, at));
    }

    /* --- 4. domain-rich action handler (shipment splitting, staged routing) --- */
    if (action.apply && now + 1e-9 >= decisionTime) {
      const ctx: ActionContext = {
        now,
        decisionTime,
        sinceDecision: now - decisionTime,
        timestepMinutes,
        inputs,
        random,
        emit: (partial) => {
          emitCounter += 1;
          emit(
            toEvent(
              { ...partial, atOffsetMinutes: 0 },
              action.id,
              now,
              `-${String(emitCounter).padStart(2, '0')}`,
            ),
          );
        },
        parameterValues: action.parameterValues,
      };
      action.apply(state, ctx);
    }

    /* --- 5. movement + delivery --- */
    advanceEntities(scenario, state, now, dt, env, emit);

    /* --- 6. resource status upkeep --- */
    for (const key of Object.keys(state.resources).sort()) {
      const resource = state.resources[key];
      // `quantity` is what REMAINS, so depletion is running out — not being
      // full. `capacity` is the starting ceiling, not a fill level.
      if (resource.quantity <= 0 && resource.kind !== 'boolean') {
        resource.status = 'depleted';
      }
    }

    /* --- 7. domain step models --- */
    for (const model of scenario.stepModels) {
      model.step(state, { now, dt, inputs, random });
    }

    /* --- 8. threshold crossings (first time only, so the log stays readable) --- */
    for (const constraint of scenario.constraints) {
      if (constraint.scope !== 'trajectory') continue;
      if (crossedConstraints.has(constraint.id)) continue;
      const actual = state.metrics[constraint.appliesTo as keyof typeof state.metrics];
      if (actual == null) continue;
      const expected = resolveConstraintValue(constraint.id, constraint.value, inputs);
      if (satisfiesNumeric(constraint.operator, actual, expected)) continue;
      crossedConstraints.add(constraint.id);
      emit({
        id: `event-threshold-${constraint.id}`,
        timestamp: now,
        type: constraint.severity === 'hard' ? 'CONSTRAINT_VIOLATED' : 'THRESHOLD_CROSSED',
        eventClass: 'system',
        message:
          constraint.severity === 'hard'
            ? `${constraint.label} breached — ${formatNumber(actual)} vs limit ${formatNumber(expected)}`
            : `${constraint.label} crossed — ${formatNumber(actual)} vs target ${formatNumber(expected)}`,
        severity: constraint.severity === 'hard' ? 'critical' : 'warning',
      });
    }

    frames.push({ state: cloneState(state), events: normalizeEventLog(stepEvents) });

    if (now >= durationMinutes) break;
  }

  return { frames, events: normalizeEventLog(allEvents) };
}

function toEvent(
  template: ActionEventTemplate,
  actionId: string,
  timestamp: number,
  suffix = '',
): SimulationEvent {
  return {
    id: `event-${actionId}-${template.id}${suffix}`,
    timestamp,
    type: template.type,
    eventClass: template.eventClass,
    entityId: template.entityId,
    resourceId: template.resourceId,
    facilityId: template.facilityId,
    routeId: template.routeId,
    causedBy: template.causedBy,
    message: template.message,
    severity: template.severity ?? 'info',
    focusEntityId: template.focusEntityId ?? template.entityId,
  };
}

/** Constraint thresholds can be overridden per run from the controls. */
export function resolveConstraintValue(
  constraintId: string,
  declared: number | string | boolean,
  inputs: SimulationInputs,
): number | string | boolean {
  const override = inputs.constraints[constraintId];
  return override === undefined ? declared : override;
}

function satisfiesNumeric(
  operator: string,
  actual: number,
  expected: number | string | boolean,
): boolean {
  if (typeof expected !== 'number') return true;
  switch (operator) {
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    case '>=':
      return actual >= expected;
    case '>':
      return actual > expected;
    case '=':
      return actual === expected;
    default:
      return true;
  }
}

function formatNumber(value: number | string | boolean): string {
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export { switchRoute };

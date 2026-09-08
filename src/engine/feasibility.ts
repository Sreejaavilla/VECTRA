/**
 * Feasibility in two levels.
 *
 *   STATIC     — properties of the initial state. Cheap, evaluated before any
 *                simulating. A hard static failure means the strategy is never
 *                simulated at all: an impossible strategy must be EXCLUDED, not
 *                merely scored badly.
 *
 *   TRAJECTORY — properties of the whole path. Only knowable after simulating.
 *                A strategy can pass every static check and still become
 *                infeasible in flight: the support vehicle exists, it is
 *                dispatched, and it simply arrives too late to stop the cargo
 *                crossing its hard temperature limit.
 *
 *   final feasibility = static AND trajectory
 *
 * Soft violations at either level never exclude anything; they become scoring
 * penalties.
 */

import type {
  ActionDefinition,
  ConstraintDefinition,
  ConstraintViolation,
  ScenarioConfig,
  SimulationInputs,
  SimulationState,
} from '../domain';
import {
  requiredQuantity,
  satisfies,
  weightsSum,
  WEIGHT_SUM_TOLERANCE,
} from '../domain';
import type { SimulationStep } from '../simulation/types';
import { buildInitialState, resolveConstraintValue } from './simulator';
import { engineError, type EngineError } from './errors';

export interface StaticFeasibility {
  staticFeasible: boolean;
  violations: ConstraintViolation[];
}

/* --------------------------------------------------------------------------- *
 * Input + scenario validation — never call the engine with invalid state.
 * --------------------------------------------------------------------------- */

export function validateInputs(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
): EngineError | null {
  const priorityKeys = Object.keys(inputs.priorities);
  if (priorityKeys.length > 0) {
    const sum = priorityKeys.reduce((total, key) => total + inputs.priorities[key], 0);
    if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
      return engineError(
        'InvalidInput',
        `Priority weights must sum to 1 (got ${sum.toFixed(4)}).`,
      );
    }
    for (const key of priorityKeys) {
      if (inputs.priorities[key] < 0) {
        return engineError('InvalidInput', `Priority "${key}" cannot be negative.`);
      }
      if (!scenario.objectives.some((o) => o.id === key)) {
        return engineError('InvalidInput', `Unknown objective "${key}" in priorities.`);
      }
    }
  }

  for (const key of Object.keys(inputs.resources)) {
    const value = inputs.resources[key];
    if (typeof value === 'number' && value < 0) {
      return engineError('InvalidInput', `Resource "${key}" cannot be negative.`);
    }
    if (!scenario.resources.some((r) => r.id === key)) {
      return engineError('InvalidInput', `Unknown resource "${key}" in inputs.`);
    }
  }

  for (const key of Object.keys(inputs.constraints)) {
    if (!scenario.constraints.some((c) => c.id === key)) {
      return engineError('InvalidInput', `Unknown constraint "${key}" in inputs.`);
    }
  }

  return null;
}

export function validateScenario(scenario: ScenarioConfig): EngineError | null {
  const { timestepMinutes, durationMinutes } = scenario.simulation;
  if (timestepMinutes <= 0) {
    return engineError('InvalidScenario', 'Timestep must be positive.');
  }
  if (durationMinutes <= 0) {
    return engineError('InvalidScenario', 'Duration must be positive.');
  }
  if (scenario.actions.length === 0) {
    return engineError('InvalidScenario', 'Scenario declares no actions.');
  }

  const facilityIds = new Set(scenario.facilities.map((f) => f.id));
  for (const route of scenario.routes) {
    if (!route.waypoints && (!facilityIds.has(route.from) || !facilityIds.has(route.to))) {
      return engineError(
        'InvalidScenario',
        `Route "${route.id}" references an unknown facility and has no waypoints.`,
      );
    }
  }

  const routeIds = new Set(scenario.routes.map((r) => r.id));
  for (const seed of scenario.initialState.entities) {
    if (seed.routeId && !routeIds.has(seed.routeId)) {
      return engineError(
        'InvalidScenario',
        `Entity "${seed.id}" starts on unknown route "${seed.routeId}".`,
      );
    }
  }

  const resourceIds = new Set(scenario.resources.map((r) => r.id));
  for (const action of scenario.actions) {
    for (const requirement of action.resourceRequirements) {
      if (!resourceIds.has(requirement.resourceId)) {
        return engineError(
          'InvalidScenario',
          `Action "${action.id}" requires unknown resource "${requirement.resourceId}".`,
        );
      }
    }
  }

  const metricIds = new Set(scenario.metrics.map((m) => String(m.id)));
  for (const objective of scenario.objectives) {
    if (!metricIds.has(String(objective.metricId))) {
      return engineError(
        'InvalidScenario',
        `Objective "${objective.id}" references unknown metric "${String(objective.metricId)}".`,
      );
    }
  }

  if (Math.abs(weightsSum(scenario.objectives) - 1) > WEIGHT_SUM_TOLERANCE) {
    return engineError('InvalidScenario', 'Scenario objective weights must sum to 1.');
  }

  return null;
}

/* --------------------------------------------------------------------------- *
 * Level 1 — static feasibility
 * --------------------------------------------------------------------------- */

function readStaticActual(
  state: SimulationState,
  ref: string,
): number | string | boolean | undefined {
  const resource = state.resources[ref];
  if (resource) return resource.quantity;
  if (ref in state.flags) return state.flags[ref];
  const metric = state.metrics[ref as keyof typeof state.metrics];
  return metric;
}

export function checkStaticFeasibility(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  action: ActionDefinition,
): StaticFeasibility {
  const state = buildInitialState(scenario, inputs);
  const violations: ConstraintViolation[] = [];

  /* --- scenario-level static constraints --- */
  for (const constraint of scenario.constraints) {
    if (constraint.scope !== 'static') continue;
    const expected = resolveConstraintValue(constraint.id, constraint.value, inputs);
    const actual = readStaticActual(state, String(constraint.appliesTo));
    if (actual === undefined) continue;
    if (satisfies(constraint.operator, actual, expected)) continue;
    violations.push({
      constraintId: constraint.id,
      label: constraint.label,
      severity: constraint.severity,
      scope: 'static',
      actual,
      expected,
      message: `${constraint.label}: ${String(actual)} does not satisfy ${constraint.operator} ${String(expected)}`,
    });
  }

  /* --- action preconditions --- */
  for (const precondition of action.preconditions) {
    let actual: number | string | boolean | undefined;
    if (precondition.kind === 'resource') {
      actual = state.resources[precondition.ref]?.quantity;
    } else if (precondition.kind === 'flag') {
      actual = state.flags[precondition.ref];
    } else {
      actual = state.metrics[precondition.ref as keyof typeof state.metrics];
    }
    if (actual === undefined) actual = 0;
    const expected = precondition.value ?? true;
    if (satisfies(precondition.operator, actual, expected)) continue;
    const label =
      precondition.kind === 'resource'
        ? (state.resources[precondition.ref]?.label ?? precondition.ref)
        : precondition.ref;
    violations.push({
      constraintId: `precondition:${action.id}:${precondition.ref}`,
      label,
      severity: 'hard',
      scope: 'static',
      actual,
      expected,
      message:
        precondition.message ??
        `${action.label} requires ${label} to be ${precondition.operator === 'available' ? 'available' : `${precondition.operator} ${String(expected)}`}`,
    });
  }

  /* --- resource requirements --- */
  for (const requirement of action.resourceRequirements) {
    const resource = state.resources[requirement.resourceId];
    const needed = requiredQuantity(requirement);
    if (!resource) {
      violations.push({
        constraintId: `resource:${action.id}:${requirement.resourceId}`,
        label: requirement.resourceId,
        severity: 'hard',
        scope: 'static',
        actual: 0,
        expected: needed,
        message: `${action.label} requires unknown resource "${requirement.resourceId}"`,
      });
      continue;
    }
    if (resource.quantity >= needed) continue;
    violations.push({
      constraintId: `resource:${action.id}:${requirement.resourceId}`,
      label: resource.label,
      severity: 'hard',
      scope: 'static',
      actual: resource.quantity,
      expected: needed,
      message: `${action.label} needs ${needed} of ${resource.label} but only ${resource.quantity} is available`,
    });
  }

  const staticFeasible = !violations.some((v) => v.severity === 'hard');
  return { staticFeasible, violations };
}

/* --------------------------------------------------------------------------- *
 * Level 2 — trajectory feasibility
 * --------------------------------------------------------------------------- */

/**
 * Walk the finished trajectory and test every trajectory-scoped constraint at
 * every step. Reports the FIRST breach of each constraint, with the minute it
 * happened, so the UI can say exactly when the strategy stopped being viable.
 */
export function evaluateTrajectoryConstraints(
  steps: readonly SimulationStep[],
  constraints: readonly ConstraintDefinition[],
  inputs: SimulationInputs,
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const trajectoryConstraints = constraints.filter((c) => c.scope === 'trajectory');

  for (const constraint of trajectoryConstraints) {
    const expected = resolveConstraintValue(constraint.id, constraint.value, inputs);
    let firstBreachAt: number | null = null;
    let peak: number | null = null;

    for (const step of steps) {
      const actual = step.metrics[constraint.appliesTo as keyof typeof step.metrics];
      if (actual == null) continue;
      if (satisfies(constraint.operator, actual, expected)) continue;
      if (firstBreachAt === null) firstBreachAt = step.timestamp;
      // The worst value reached, which is the number that matters downstream.
      const moreExtreme =
        peak === null ||
        (constraint.operator === '<' || constraint.operator === '<='
          ? actual > peak
          : actual < peak);
      if (moreExtreme) peak = actual;
    }

    if (firstBreachAt === null || peak === null) continue;
    violations.push({
      constraintId: constraint.id,
      label: constraint.label,
      severity: constraint.severity,
      scope: 'trajectory',
      actual: peak,
      expected,
      atMinutes: firstBreachAt,
      message: `${constraint.label}: first breached at minute ${firstBreachAt}, ${
        constraint.operator === '<' || constraint.operator === '<=' ? 'peaking at' : 'bottoming out at'
      } ${format(peak)} (limit ${String(expected)})`,
    });
  }

  return violations;
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * Final-state constraints are tested against the LAST step only. This is the
 * clean home for "the shipment must actually have been delivered" — a metric
 * like service coverage is legitimately unsatisfied at every step until the end.
 */
export function evaluateFinalConstraints(
  steps: readonly SimulationStep[],
  constraints: readonly ConstraintDefinition[],
  inputs: SimulationInputs,
): ConstraintViolation[] {
  const last = steps[steps.length - 1];
  if (!last) return [];
  const violations: ConstraintViolation[] = [];

  for (const constraint of constraints) {
    if (constraint.scope !== 'final') continue;
    const expected = resolveConstraintValue(constraint.id, constraint.value, inputs);
    const actual = last.metrics[constraint.appliesTo as keyof typeof last.metrics];
    if (actual == null) continue;
    if (satisfies(constraint.operator, actual, expected)) continue;
    violations.push({
      constraintId: constraint.id,
      label: constraint.label,
      severity: constraint.severity,
      scope: 'final',
      actual,
      expected,
      atMinutes: last.timestamp,
      message: `${constraint.label}: ended at ${format(
        typeof actual === 'number' ? actual : 0,
      )} (required ${constraint.operator} ${String(expected)})`,
    });
  }

  return violations;
}

/** Post-simulation feasibility: no hard violation from either the trajectory or
 *  the final-state checks. */
export function isTrajectoryFeasible(violations: readonly ConstraintViolation[]): boolean {
  return !violations.some(
    (v) => (v.scope === 'trajectory' || v.scope === 'final') && v.severity === 'hard',
  );
}

/**
 * Constraints come in two scopes, and conflating them is the classic modelling
 * error this engine avoids:
 *
 *   static     — a property of the INITIAL STATE.
 *                "a support vehicle is available", "budget >= action cost".
 *                Evaluated before simulating; a hard failure means the strategy
 *                is never simulated at all.
 *
 *   trajectory — a property of the WHOLE TRAJECTORY.
 *                "temperature must never exceed 8", "viability must never fall
 *                below 30", "delay must not exceed 90".
 *                Checked at EVERY step. Can only be evaluated after simulating.
 *
 *   final      — a property of the LAST step only.
 *                "service coverage must reach 1", "final viability >= 30".
 *                A per-step check would fire falsely at t=0 (coverage starts at
 *                0); this scope waits for the shipment to have had its chance.
 *
 *   final feasibility = static AND trajectory AND final
 *
 * Hard constraints determine feasibility. Soft constraints never make a
 * strategy impossible — they lower its score.
 */

import type { MetricKey } from './metric';

export type ConstraintOperator =
  | '<'
  | '<='
  | '='
  | '>='
  | '>'
  | 'available'
  | 'unavailable';

export type ConstraintScope = 'static' | 'trajectory' | 'final';

export type ConstraintSeverity = 'hard' | 'soft';

export interface ConstraintDefinition {
  id: string;
  /** Free-form grouping label: 'temperature', 'budget', 'vehicle', ... */
  type: string;
  label: string;
  severity: ConstraintSeverity;
  scope: ConstraintScope;
  operator: ConstraintOperator;
  value: number | string | boolean;
  /** Metric key (trajectory scope) or resource id (static scope). */
  appliesTo: MetricKey | string;
  /** Penalty subtracted from the aggregate score per soft violation (0..1). */
  softPenalty?: number;
}

export interface ConstraintViolation {
  constraintId: string;
  label: string;
  severity: ConstraintSeverity;
  scope: ConstraintScope;
  actual: number | string | boolean;
  expected: number | string | boolean;
  /** Simulation minute of the violation. Set for trajectory violations only. */
  atMinutes?: number;
  message: string;
}

/**
 * Two-level feasibility. `trajectoryFeasible` is `null` until the strategy has
 * actually been simulated — a statically-infeasible strategy never gets that
 * far, and reporting `true` for it would be a lie.
 */
export interface FeasibilityReport {
  strategyId: string;
  staticFeasible: boolean;
  trajectoryFeasible: boolean | null;
  /** staticFeasible && trajectoryFeasible === true */
  feasible: boolean;
  violations: ConstraintViolation[];
}

/** Evaluate a comparison operator against a concrete value. */
export function satisfies(
  operator: ConstraintOperator,
  actual: number | string | boolean,
  expected: number | string | boolean,
): boolean {
  switch (operator) {
    case 'available':
      return actual === true || (typeof actual === 'number' && actual > 0);
    case 'unavailable':
      return actual === false || (typeof actual === 'number' && actual <= 0);
    case '=':
      return actual === expected;
    default:
      break;
  }
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (operator) {
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    case '>=':
      return actual >= expected;
    case '>':
      return actual > expected;
    default:
      return false;
  }
}

export function describeOperator(operator: ConstraintOperator): string {
  switch (operator) {
    case 'available':
      return 'must be available';
    case 'unavailable':
      return 'must be unavailable';
    default:
      return operator;
  }
}

/** Compose a FeasibilityReport from its two levels. */
export function combineFeasibility(
  strategyId: string,
  staticFeasible: boolean,
  trajectoryFeasible: boolean | null,
  violations: ConstraintViolation[],
): FeasibilityReport {
  return {
    strategyId,
    staticFeasible,
    trajectoryFeasible,
    feasible: staticFeasible && trajectoryFeasible === true,
    violations,
  };
}

export function hardViolations(violations: readonly ConstraintViolation[]): ConstraintViolation[] {
  return violations.filter((v) => v.severity === 'hard');
}

export function softViolations(violations: readonly ConstraintViolation[]): ConstraintViolation[] {
  return violations.filter((v) => v.severity === 'soft');
}

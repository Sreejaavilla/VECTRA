/**
 * `runSimulation` — simulate ONE strategy and return the immutable result.
 *
 * Order matters and is the point of the design:
 *   validate -> static feasibility -> simulate -> trajectory feasibility -> score
 *
 * A statically-infeasible strategy is never simulated (an impossible action
 * must be excluded, not scored badly). A statically-feasible one is simulated
 * and THEN judged against the constraints its own trajectory has to satisfy.
 */

import type {
  ConstraintViolation,
  ScenarioConfig,
  SimulationInputs,
  SimulationOptions,
} from '../domain';
import { combineFeasibility, findAction, normalizeEventLog } from '../domain';
import type {
  RunIdentity,
  SimulationOutcome,
  SimulationResult,
  SimulationStep,
} from '../simulation/types';
import { SCHEMA_VERSION } from '../simulation/types';
import { framesToSteps } from './adapter';
import { engineError, type EngineResult } from './errors';
import {
  checkStaticFeasibility,
  evaluateFinalConstraints,
  evaluateTrajectoryConstraints,
  isTrajectoryFeasible,
  validateInputs,
  validateScenario,
} from './feasibility';
import { buildDecisionImpact, riskLabel } from './metrics';
import { deriveSeed } from './rng';
import { simulateTrajectory } from './simulator';
import { scoreTrajectory, toTradeoffScores } from './scoring';

export const ENGINE_VERSION = '1.0.0';

export interface RunOutput {
  result: SimulationResult;
  /** Σ contributions - penalty, for candidate comparison. */
  score: number;
  contributions: ReturnType<typeof scoreTrajectory>['contributions'];
  penalty: number;
}

export function runSimulation(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  strategyId: string,
  options: SimulationOptions = {},
): EngineResult<RunOutput> {
  const scenarioError = validateScenario(scenario);
  if (scenarioError) return { ok: false, error: scenarioError };

  const inputError = validateInputs(scenario, inputs);
  if (inputError) return { ok: false, error: inputError };

  const action = findAction(scenario, strategyId);
  if (!action) {
    return {
      ok: false,
      error: engineError('InvalidInput', `Unknown strategy "${strategyId}".`),
    };
  }

  /* --- level 1: static feasibility --- */
  const staticCheck = checkStaticFeasibility(scenario, inputs, action);
  if (!staticCheck.staticFeasible) {
    return {
      ok: false,
      error: engineError(
        'ConstraintViolation',
        `${action.label} is not feasible from the initial state.`,
        staticCheck.violations,
      ),
    };
  }

  /* --- simulate --- */
  const seed =
    options.seed ?? deriveSeed(scenario.id, strategyId, inputs, ENGINE_VERSION);
  const trajectory = simulateTrajectory(scenario, inputs, action, seed);
  const steps = framesToSteps(scenario, trajectory.frames);
  const events = normalizeEventLog(trajectory.events);

  /* --- level 2: trajectory + final-state feasibility --- */
  const trajectoryViolations = evaluateTrajectoryConstraints(
    steps,
    scenario.constraints,
    inputs,
  );
  const finalViolations = evaluateFinalConstraints(steps, scenario.constraints, inputs);
  const postViolations = [...trajectoryViolations, ...finalViolations];
  const trajectoryFeasible = isTrajectoryFeasible(postViolations);
  const violations: ConstraintViolation[] = [
    ...staticCheck.violations,
    ...postViolations,
  ];
  const feasibility = combineFeasibility(
    strategyId,
    true,
    trajectoryFeasible,
    violations,
  );

  /* --- score --- */
  const scored = scoreTrajectory(
    steps,
    scenario.metrics,
    scenario.objectives,
    inputs,
    violations,
  );

  const outcome = buildOutcome(scenario, action.label, steps, feasibility.feasible);
  const decisionImpact = buildDecisionImpact(steps, events, scenario.metrics);

  const run: RunIdentity = {
    runId: `run-${String(options.runNumber ?? 1).padStart(3, '0')}-${strategyId}`,
    runNumber: options.runNumber ?? 1,
    label: action.label,
    inputs: flattenInputs(inputs, strategyId),
    structuredInputs: inputs,
    seed,
    engineVersion: ENGINE_VERSION,
    schemaVersion: SCHEMA_VERSION,
  };

  const result: SimulationResult = {
    run,
    scenario,
    strategy: strategyId,
    strategyLabel: action.label,
    duration: scenario.simulation.durationMinutes,
    steps,
    events,
    outcome,
    feasibility,
    violations,
    decisionImpact,
    tradeoffs: [
      { strategy: action.label, scores: toTradeoffScores(scored.contributions) },
    ],
    cascadeFaults: trajectory.cascadeFaults,
    firedCascadeRuleIds: trajectory.firedCascadeRuleIds,
  };

  return {
    ok: true,
    value: {
      result,
      score: scored.score,
      contributions: scored.contributions,
      penalty: scored.penalty,
    },
  };
}

function buildOutcome(
  scenario: ScenarioConfig,
  label: string,
  steps: readonly SimulationStep[],
  feasible: boolean,
): SimulationOutcome {
  const finalMetrics = steps[steps.length - 1]?.metrics ?? {};
  const viability = finalMetrics.viability ?? 0;
  const delivered = scenario.initialState.shipmentAllocations;
  const totalDoses = Object.keys(delivered).reduce((sum, key) => sum + delivered[key], 0);

  const status: SimulationOutcome['status'] = !feasible
    ? 'failed'
    : viability >= 70
      ? 'success'
      : 'partial';

  const summary = !feasible
    ? `${label}: became infeasible in flight — the shipment breached a hard limit before it could be secured.`
    : status === 'success'
      ? `${label}: ${totalDoses.toLocaleString()} doses secured with ${viability.toFixed(0)}% viability retained.`
      : `${label}: shipment secured but only ${viability.toFixed(0)}% viability retained.`;

  return {
    strategy: label,
    status,
    summary,
    finalMetrics: { ...finalMetrics },
  };
}

function flattenInputs(
  inputs: SimulationInputs,
  strategyId: string,
): Record<string, string | number> {
  const out: Record<string, string | number> = { strategy: strategyId };
  for (const key of Object.keys(inputs.resources).sort()) {
    const value = inputs.resources[key];
    out[key] = typeof value === 'boolean' ? (value ? 'available' : 'unavailable') : value;
  }
  for (const key of Object.keys(inputs.constraints).sort()) {
    const value = inputs.constraints[key];
    out[key] = typeof value === 'boolean' ? String(value) : value;
  }
  for (const key of Object.keys(inputs.priorities).sort()) {
    out[key] = Math.round(inputs.priorities[key] * 100) / 100;
  }
  return out;
}

export { riskLabel };

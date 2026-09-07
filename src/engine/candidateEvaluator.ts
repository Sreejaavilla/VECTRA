/**
 * `evaluateScenario` — the whole decision space for one set of inputs.
 *
 * This enumerates the actions the scenario declares, checks each for static
 * feasibility, simulates the survivors from the SAME initial state, judges each
 * trajectory, scores the feasible ones and recommends a winner.
 *
 * Naming note: this is candidate enumeration plus selection, not a general
 * optimizer. There is no parameter sweep and no combinatorial search — the
 * decision space is exactly the actions the scenario declares. When that stops
 * being true, this is where a real search goes.
 */

import type {
  ScenarioConfig,
  SimulationInputs,
  SimulationOptions,
} from '../domain';
import { combineFeasibility, findAction } from '../domain';
import type { ScenarioEvaluation, SimulationResult } from '../simulation/types';
import type { EngineResult } from './errors';
import {
  checkStaticFeasibility,
  validateInputs,
  validateScenario,
} from './feasibility';
import { recommend, type ScoredCandidate } from './recommendation';
import { runSimulation } from './runner';

export function evaluateScenario(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  options: SimulationOptions = {},
): EngineResult<ScenarioEvaluation> {
  const scenarioError = validateScenario(scenario);
  if (scenarioError) return { ok: false, error: scenarioError };
  const inputError = validateInputs(scenario, inputs);
  if (inputError) return { ok: false, error: inputError };

  const candidates: ScoredCandidate[] = [];
  const results: SimulationResult[] = [];
  const infeasibleStrategies: ScenarioEvaluation['infeasibleStrategies'] = [];

  for (const action of scenario.actions) {
    /* --- level 1: never simulate an impossible action --- */
    const staticCheck = checkStaticFeasibility(scenario, inputs, action);
    if (!staticCheck.staticFeasible) {
      const report = combineFeasibility(action.id, false, null, staticCheck.violations);
      infeasibleStrategies.push(report);
      candidates.push({
        strategyId: action.id,
        label: action.label,
        score: Number.NEGATIVE_INFINITY,
        penalty: 0,
        contributions: [],
        feasibility: report,
      });
      continue;
    }

    /* --- simulate, then judge the trajectory --- */
    const run = runSimulation(scenario, inputs, action.id, options);
    if (!run.ok) {
      const report = combineFeasibility(
        action.id,
        false,
        null,
        run.error.details ?? [],
      );
      infeasibleStrategies.push(report);
      candidates.push({
        strategyId: action.id,
        label: action.label,
        score: Number.NEGATIVE_INFINITY,
        penalty: 0,
        contributions: [],
        feasibility: report,
      });
      continue;
    }

    const { result, score, contributions, penalty } = run.value;
    results.push(result);
    candidates.push({
      strategyId: action.id,
      label: action.label,
      score,
      penalty,
      contributions,
      feasibility: result.feasibility,
    });

    // Statically fine, but the trajectory breached a hard limit: still reported
    // as infeasible, and its result is still returned so the UI can show WHY.
    if (!result.feasibility.feasible) infeasibleStrategies.push(result.feasibility);
  }

  const recommendation = recommend(candidates);

  /* --- attach the shared recommendation to every returned result --- */
  const enriched = results.map((result) => ({
    ...result,
    recommendation: recommendation ?? undefined,
    tradeoffs: recommendation ? recommendation.tradeoffs : result.tradeoffs,
  }));

  return {
    ok: true,
    value: {
      scenario,
      inputs,
      feasibleStrategies: candidates
        .filter((c) => c.feasibility.feasible)
        .map((c) => c.strategyId),
      infeasibleStrategies,
      results: enriched,
      recommendation,
    },
  };
}

export { findAction };

/**
 * `evaluateScenario` — the whole decision space for one set of inputs.
 *
 * Actions that declare `parameters` are expanded into the Cartesian product of
 * their parameter values. Each variant is simulated independently, then the
 * results are PRUNED: only the highest-scoring parameterization of each base
 * action is surfaced to the caller. The expansion is purely internal — every id
 * that leaves this module is the original base action id, so the UI,
 * sensitivity analysis, and tests never see the expanded variants.
 */

import type {
  ActionDefinition,
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

/* --------------------------------------------------------------------------- *
 * Combinatorial expansion
 * --------------------------------------------------------------------------- */

/**
 * Expand an action with `parameters` into every combination. Actions without
 * parameters pass through unchanged. Each variant gets a unique internal id
 * and `baseId` pointing back to the original.
 */
export function expandAction(action: ActionDefinition): ActionDefinition[] {
  if (!action.parameters || Object.keys(action.parameters).length === 0) {
    return [action];
  }

  const keys = Object.keys(action.parameters).sort();
  const combinations: Record<string, number | string | boolean>[] = [];

  function generate(idx: number, current: Record<string, number | string | boolean>) {
    if (idx === keys.length) {
      combinations.push({ ...current });
      return;
    }
    const key = keys[idx];
    for (const val of action.parameters![key].values) {
      current[key] = val;
      generate(idx + 1, current);
    }
  }
  generate(0, {});

  return combinations.map((combo) => {
    const suffix = keys.map((k) => `${k}=${combo[k]}`).join(',');
    const internalId = `${action.id}__${suffix}`;

    // Apply well-known parameter overrides to the action definition itself.
    let decisionTime = action.decisionTimeMinutes;
    if (typeof combo['decisionTimeMinutes'] === 'number') {
      decisionTime = combo['decisionTimeMinutes'];
    }

    return {
      ...action,
      id: internalId,
      baseId: action.id,
      label: action.label,
      decisionTimeMinutes: decisionTime,
      parameterValues: combo,
    };
  });
}

/** Resolve the base action id for an expanded or plain action. */
function baseIdOf(action: ActionDefinition): string {
  return action.baseId ?? action.id;
}

/* --------------------------------------------------------------------------- *
 * Remap: replace all expanded ids with the base id on public-facing data
 * --------------------------------------------------------------------------- */

function remapResult(
  result: SimulationResult,
  baseId: string,
  baseLabel: string,
  parameterValues?: Record<string, number | string | boolean>,
): SimulationResult {
  const internalId = result.strategy;
  return {
    ...result,
    strategy: baseId,
    strategyLabel: baseLabel,
    feasibility: { ...result.feasibility, strategyId: baseId },
    // The swept variant id never leaves the engine — scrub it from every place
    // the runner stamped it, not just `strategy`.
    run: {
      ...result.run,
      runId: result.run.runId.replace(internalId, baseId),
      inputs: { ...result.run.inputs, strategy: baseId },
    },
    chosenParameters:
      parameterValues && Object.keys(parameterValues).length > 0
        ? { ...parameterValues }
        : undefined,
  };
}

function remapCandidate(candidate: ScoredCandidate, baseId: string, baseLabel: string): ScoredCandidate {
  return {
    ...candidate,
    strategyId: baseId,
    label: baseLabel,
    feasibility: { ...candidate.feasibility, strategyId: baseId },
  };
}

/* --------------------------------------------------------------------------- *
 * Main entry point
 * --------------------------------------------------------------------------- */

export function evaluateScenario(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  options: SimulationOptions = {},
): EngineResult<ScenarioEvaluation> {
  const scenarioError = validateScenario(scenario);
  if (scenarioError) return { ok: false, error: scenarioError };
  const inputError = validateInputs(scenario, inputs);
  if (inputError) return { ok: false, error: inputError };

  /* --- expand parameterized actions --- */
  const expandedActions = scenario.actions.flatMap(expandAction);
  const scenarioWithExpanded = { ...scenario, actions: expandedActions };

  // Build a lookup from base id -> original action label for remapping.
  const baseLabelMap = new Map<string, string>();
  for (const action of scenario.actions) {
    baseLabelMap.set(action.id, action.label);
  }

  /* --- evaluate every variant --- */
  interface InternalResult {
    candidate: ScoredCandidate;
    result?: SimulationResult;
    action: ActionDefinition;
  }

  const allInternal: InternalResult[] = [];

  for (const action of expandedActions) {
    const staticCheck = checkStaticFeasibility(scenario, inputs, action);
    if (!staticCheck.staticFeasible) {
      const report = combineFeasibility(action.id, false, null, staticCheck.violations);
      allInternal.push({
        candidate: {
          strategyId: action.id,
          label: action.label,
          score: Number.NEGATIVE_INFINITY,
          penalty: 0,
          contributions: [],
          feasibility: report,
        },
        action,
      });
      continue;
    }

    const run = runSimulation(scenarioWithExpanded, inputs, action.id, options);
    if (!run.ok) {
      const report = combineFeasibility(action.id, false, null, run.error.details ?? []);
      allInternal.push({
        candidate: {
          strategyId: action.id,
          label: action.label,
          score: Number.NEGATIVE_INFINITY,
          penalty: 0,
          contributions: [],
          feasibility: report,
        },
        action,
      });
      continue;
    }

    const { result, score, contributions, penalty } = run.value;
    allInternal.push({
      candidate: {
        strategyId: action.id,
        label: action.label,
        score,
        penalty,
        contributions,
        feasibility: result.feasibility,
      },
      result,
      action,
    });
  }

  /* --- prune: keep only the best variant per base action --- */
  // Tie-break: `>=` means the LAST equally-good variant wins. Scenario authors
  // list a swept parameter in ascending "permissiveness" (e.g. decision time
  // 36→44), so on a tie this reports the most permissive setting that still
  // achieves the best outcome — "you have until minute 40", not "minute 36".
  // Deterministic: `allInternal` is built in scenario declaration × parameter
  // declaration order.
  const bestPerBase = new Map<string, InternalResult>();
  for (const entry of allInternal) {
    const base = baseIdOf(entry.action);
    const existing = bestPerBase.get(base);
    if (
      !existing ||
      entry.candidate.score >= existing.candidate.score
    ) {
      bestPerBase.set(base, entry);
    }
  }

  /* --- remap everything to base ids --- */
  const candidates: ScoredCandidate[] = [];
  const results: SimulationResult[] = [];
  const infeasibleStrategies: ScenarioEvaluation['infeasibleStrategies'] = [];

  for (const [baseId, entry] of bestPerBase) {
    const baseLabel = baseLabelMap.get(baseId) ?? entry.action.label;
    const candidate = remapCandidate(entry.candidate, baseId, baseLabel);
    candidates.push(candidate);

    if (entry.result) {
      results.push(
        remapResult(entry.result, baseId, baseLabel, entry.action.parameterValues),
      );
    }

    if (!candidate.feasibility.feasible) {
      infeasibleStrategies.push(candidate.feasibility);
    }
  }

  const recommendation = recommend(candidates);

  /* --- carry the winner's chosen configuration onto the recommendation --- */
  if (recommendation) {
    const winning = results.find((r) => r.strategy === recommendation.strategyId);
    if (winning?.chosenParameters) {
      recommendation.chosenParameters = { ...winning.chosenParameters };
    }
  }

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

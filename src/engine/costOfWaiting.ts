/**
 * Cost of waiting (Checkpoint 5).
 *
 * The operator can act now, or in 5 / 10 / 15 minutes. Every later decision is
 * a REAL evaluation from that later decision state — the incident timeline is
 * unchanged, only the operator's decision moment moves. What shrinks is the set
 * of options that still work: a shipment left warming for another ten minutes
 * may cross a hard limit no intervention can undo.
 *
 * Nothing here interpolates. Each row is `evaluateScenario` on a scenario whose
 * actions all decide `offsetMinutes` later.
 */

import type { ScenarioConfig, SimulationInputs, SimulationOptions } from '../domain';
import { evaluateScenario } from './candidateEvaluator';
import type { EngineResult } from './errors';
import { validateInputs, validateScenario } from './feasibility';

export interface WaitRow {
  offsetMinutes: number;
  /** Absolute simulation minute the decision would now be taken. */
  decisionMinute: number;
  feasibleCount: number;
  feasibleStrategyIds: string[];
  recommendedStrategyId: string | null;
  recommendationScore: number | null;
}

export interface CostOfWaitingReport {
  rows: WaitRow[];
  /** Latest offset at which at least one option is still feasible. `null` when
   *  every tested offset still has one; -1 when even "now" has none. */
  decisionWindowMinutes: number | null;
  evaluations: number;
}

export interface CostOfWaitingOptions {
  /** Minutes to delay the decision, ascending, first is usually 0 (now). */
  offsets?: number[];
}

const DEFAULT_OFFSETS = [0, 5, 10, 15];

/** A scenario whose every action decides `delay` minutes later. */
function deferDecision(scenario: ScenarioConfig, delay: number): ScenarioConfig {
  if (delay === 0) return scenario;
  return {
    ...scenario,
    actions: scenario.actions.map((a) => ({
      ...a,
      decisionTimeMinutes: a.decisionTimeMinutes + delay,
      parameters: a.parameters
        ? Object.fromEntries(
            Object.entries(a.parameters).map(([key, param]) => [
              key,
              key === 'decisionTimeMinutes'
                ? { ...param, values: param.values.map((v) => (typeof v === 'number' ? v + delay : v)) }
                : param,
            ]),
          )
        : undefined,
    })),
  };
}

export function costOfWaiting(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  options: CostOfWaitingOptions = {},
  simOptions: SimulationOptions = {},
): EngineResult<CostOfWaitingReport> {
  const scenarioError = validateScenario(scenario);
  if (scenarioError) return { ok: false, error: scenarioError };
  const inputError = validateInputs(scenario, inputs);
  if (inputError) return { ok: false, error: inputError };

  const offsets = [...(options.offsets ?? DEFAULT_OFFSETS)].sort((a, b) => a - b);
  const baseDecision = Math.min(...scenario.actions.map((a) => a.decisionTimeMinutes));

  let evaluations = 0;
  const rows: WaitRow[] = [];

  for (const offset of offsets) {
    const variant = deferDecision(scenario, offset);
    const outcome = evaluateScenario(variant, inputs, simOptions);
    evaluations += 1;
    if (!outcome.ok) {
      rows.push({
        offsetMinutes: offset,
        decisionMinute: baseDecision + offset,
        feasibleCount: 0,
        feasibleStrategyIds: [],
        recommendedStrategyId: null,
        recommendationScore: null,
      });
      continue;
    }
    const feasible = [...outcome.value.feasibleStrategies].sort();
    rows.push({
      offsetMinutes: offset,
      decisionMinute: baseDecision + offset,
      feasibleCount: feasible.length,
      feasibleStrategyIds: feasible,
      recommendedStrategyId: outcome.value.recommendation?.strategyId ?? null,
      recommendationScore: outcome.value.recommendation?.score ?? null,
    });
  }

  const lastViable = [...rows].reverse().find((r) => r.feasibleCount > 0);
  const decisionWindowMinutes = lastViable
    ? lastViable.offsetMinutes === offsets[offsets.length - 1]
      ? null // still fine at the last tested offset
      : lastViable.offsetMinutes
    : -1;

  return { ok: true, value: { rows, decisionWindowMinutes, evaluations } };
}

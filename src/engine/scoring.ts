/**
 * Multi-objective scoring.
 *
 *   normalized_i   = clamp((aggregated_i - min_i) / (max_i - min_i), 0, 1)
 *                    flipped for 'minimize' so 1 is always good
 *   contribution_i = weight_i * normalized_i
 *   score          = Σ contribution_i - Σ softPenalty
 *
 * The full breakdown is returned rather than just the total, so the
 * recommendation's explanation is DERIVED from the arithmetic instead of being
 * a sentence someone wrote next to it.
 */

import type {
  ConstraintViolation,
  MetricDefinition,
  ObjectiveContribution,
  ObjectiveDefinition,
  SimulationInputs,
} from '../domain';
import { findMetric, normalizeMetric } from '../domain';
import type { SimulationStep } from '../simulation/types';
import { aggregateTrajectory } from './metrics';

export interface StrategyScore {
  /** Σ contributions - penalty. */
  score: number;
  /** Σ contributions, before penalties. */
  rawScore: number;
  penalty: number;
  contributions: ObjectiveContribution[];
  /** Aggregated raw metric values, keyed by metric id. */
  aggregated: Record<string, number>;
}

/** Effective weight for an objective: an input priority overrides the default. */
export function effectiveWeight(
  objective: ObjectiveDefinition,
  inputs: SimulationInputs,
): number {
  const override = inputs.priorities[objective.id];
  return override === undefined ? objective.weight : override;
}

export function scoreTrajectory(
  steps: readonly SimulationStep[],
  metrics: readonly MetricDefinition[],
  objectives: readonly ObjectiveDefinition[],
  inputs: SimulationInputs,
  violations: readonly ConstraintViolation[],
): StrategyScore {
  const aggregated = aggregateTrajectory(steps, metrics);
  const contributions: ObjectiveContribution[] = [];

  for (const objective of objectives) {
    const definition = findMetric(metrics, String(objective.metricId));
    if (!definition) continue;
    const rawValue = aggregated[String(objective.metricId)] ?? 0;
    const weight = effectiveWeight(objective, inputs);
    const normalizedValue = normalizeMetric(definition, rawValue);
    contributions.push({
      objectiveId: objective.id,
      label: objective.label,
      metricId: objective.metricId,
      rawValue,
      weight,
      normalizedValue,
      contribution: weight * normalizedValue,
    });
  }

  const rawScore = contributions.reduce((total, c) => total + c.contribution, 0);
  const penalty = violations
    .filter((v) => v.severity === 'soft')
    .reduce((total, v) => total + softPenaltyFor(v), 0);

  return {
    score: rawScore - penalty,
    rawScore,
    penalty,
    contributions,
    aggregated,
  };
}

const DEFAULT_SOFT_PENALTY = 0.05;

function softPenaltyFor(violation: ConstraintViolation): number {
  // Constraint definitions may declare their own penalty; the violation record
  // does not carry it, so callers that need per-constraint penalties pass the
  // scenario-resolved value through `softPenalty` on the definition.
  return violation.severity === 'soft' ? DEFAULT_SOFT_PENALTY : 0;
}

/**
 * Normalized objective values per strategy, shaped for the trade-off matrix.
 * Maps 0..1 onto the matrix's -1..2 scale so the presentation layer stays a
 * presentation layer.
 */
export function toTradeoffScores(
  contributions: readonly ObjectiveContribution[],
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const contribution of contributions) {
    const n = contribution.normalizedValue;
    scores[contribution.label] = n >= 0.8 ? 2 : n >= 0.55 ? 1 : n >= 0.3 ? 0 : -1;
  }
  return scores;
}

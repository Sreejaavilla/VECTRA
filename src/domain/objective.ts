/**
 * Objectives attach a weight to a metric. The metric itself owns direction,
 * aggregation and normalization (see `metric.ts`) — an objective only says how
 * much that metric matters.
 *
 * Weight convention (global, do not mix): weights sum to 1.
 */

import type { MetricKey } from './metric';

export interface ObjectiveDefinition {
  id: string;
  label: string;
  /** References a MetricDefinition.id. */
  metricId: MetricKey | string;
  weight: number;
}

/**
 * The arithmetic behind a score, exposed so explanations are derived rather
 * than written. `contribution = weight * normalizedValue`, and the
 * contributions of a strategy sum to its raw score.
 */
export interface ObjectiveContribution {
  objectiveId: string;
  label: string;
  metricId: MetricKey | string;
  /** Aggregated raw metric value before normalization (e.g. peak temperature). */
  rawValue: number;
  weight: number;
  /** 0..1, already flipped so that 1 is always "good". */
  normalizedValue: number;
  contribution: number;
}

export const WEIGHT_SUM_TOLERANCE = 1e-6;

export function weightsSum(objectives: readonly { weight: number }[]): number {
  return objectives.reduce((total, o) => total + o.weight, 0);
}

export function weightsAreNormalized(objectives: readonly { weight: number }[]): boolean {
  return Math.abs(weightsSum(objectives) - 1) <= WEIGHT_SUM_TOLERANCE;
}

/**
 * Rescale arbitrary positive weights (e.g. 0-100 UI sliders) so they sum to 1.
 * Returns an equal split when every weight is zero.
 */
export function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const keys = Object.keys(weights).sort();
  const total = keys.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  const out: Record<string, number> = {};
  if (total <= 0) {
    const share = keys.length === 0 ? 0 : 1 / keys.length;
    for (const key of keys) out[key] = share;
    return out;
  }
  for (const key of keys) out[key] = Math.max(0, weights[key]) / total;
  return out;
}

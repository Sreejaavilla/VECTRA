/**
 * Trajectory aggregation and decision impact.
 *
 * How a metric collapses from a whole trajectory to one number is a material
 * modelling choice, not a detail: a strategy whose viability ends at 82 having
 * dipped to 41 is not the same as one that ends at 78 having never gone below
 * 65. Each metric declares its own aggregation and this module honours it.
 */

import type {
  MetricDefinition,
  MetricDelta,
  SimulationEvent,
  StepMetrics,
} from '../domain';
import { aggregateMetric, resolveEventClass, toMetricDelta } from '../domain';
import type { DecisionImpact, SimulationStep } from '../simulation/types';

/** Series of one metric across the trajectory, skipping steps where it is absent. */
export function metricSeries(
  steps: readonly SimulationStep[],
  metricId: string,
): number[] {
  const out: number[] = [];
  for (const step of steps) {
    const value = step.metrics[metricId as keyof StepMetrics];
    if (value != null) out.push(value);
  }
  return out;
}

/** Collapse every declared metric to the single value that gets scored. */
export function aggregateTrajectory(
  steps: readonly SimulationStep[],
  metrics: readonly MetricDefinition[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const definition of metrics) {
    const series = metricSeries(steps, String(definition.id));
    out[String(definition.id)] = aggregateMetric(definition, series);
  }
  return out;
}

/**
 * Before/after around the first decision event, with each metric's delta read
 * through that metric's own declared direction — never through whether the
 * metric happens to carry an objective weight. Temperature falling from 8 to 5
 * is "better" whether or not anybody is optimising for it.
 */
export function buildDecisionImpact(
  steps: readonly SimulationStep[],
  events: readonly SimulationEvent[],
  metrics: readonly MetricDefinition[],
): DecisionImpact | undefined {
  const decision = events.find((event) => resolveEventClass(event) === 'decision');
  if (!decision || steps.length === 0) return undefined;

  // Strictly BEFORE the decision: the step at the decision's own timestamp has
  // already had the action's transitions applied to it, so using it would show
  // the budget as already spent and report a delta of zero. "Before" means the
  // state the operator was looking at when they had to choose.
  const beforeStep =
    [...steps].reverse().find((step) => step.timestamp < decision.timestamp) ?? steps[0];
  const finalStep = steps[steps.length - 1];

  const changes: MetricDelta[] = [];
  for (const definition of metrics) {
    const key = String(definition.id) as keyof StepMetrics;
    const before = beforeStep.metrics[key];
    const after = finalStep.metrics[key];
    if (before == null || after == null) continue;
    changes.push(toMetricDelta(definition, before, after));
  }

  return {
    decisionEventId: decision.id,
    before: { ...beforeStep.metrics },
    projected: { ...finalStep.metrics },
    riskBefore: riskLabel(beforeStep.metrics.viability),
    riskAfter: riskLabel(finalStep.metrics.viability),
    changes,
  };
}

export function riskLabel(viability: number | undefined): string {
  if (viability == null) return 'UNKNOWN';
  if (viability >= 85) return 'LOW';
  if (viability >= 70) return 'MODERATE';
  if (viability >= 50) return 'HIGH';
  return 'CRITICAL';
}

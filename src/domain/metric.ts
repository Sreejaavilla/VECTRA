/**
 * Metric definitions — the SINGLE SOURCE OF TRUTH for how a metric is
 * normalized, collapsed from a trajectory to one scoring value, and read as a
 * "better"/"worse" delta.
 *
 * Scoring, decision-impact deltas and explanation text all consult
 * `MetricDefinition`. Nothing infers a metric's direction from whether it
 * happens to be an objective — a metric can matter (temperature) without
 * carrying an objective weight.
 */

export interface StepMetrics {
  temperature?: number;
  viability?: number;
  cost?: number;
  delay?: number;
  risk?: number;
  /** Cumulative degree-minutes above the safe temperature. */
  exposure?: number;
}

export type MetricKey = keyof StepMetrics;

/** Every metric key, in a fixed order. Used wherever metrics are iterated. */
export const METRIC_KEYS: readonly MetricKey[] = [
  'temperature',
  'viability',
  'cost',
  'delay',
  'risk',
  'exposure',
];

/** Display thresholds the charts draw. Not the same thing as a constraint. */
export interface MetricThresholds {
  safe?: number;
  critical?: number;
  min?: number;
  max?: number;
}

export type MetricDirection = 'minimize' | 'maximize';

/**
 * How a whole trajectory collapses to the one number that gets scored.
 * This choice is material: a strategy whose viability ends at 82 but dips to 41
 * is not the same as one that ends at 78 having never gone below 65.
 */
export type MetricAggregation = 'final' | 'min' | 'max' | 'cumulative';

export interface MetricDefinition {
  id: MetricKey | string;
  label: string;
  direction: MetricDirection;
  aggregation: MetricAggregation;
  /** Range used to map the aggregated value onto 0..1 before weighting. */
  normalize: { min: number; max: number };
  unit?: string;
  /** |delta| at or below this reads as 'neutral' in a MetricDelta. */
  epsilon?: number;
}

export interface MetricDelta {
  metric: MetricKey | string;
  label: string;
  before: number;
  after: number;
  delta: number;
  direction: 'better' | 'worse' | 'neutral';
}

/** Look up a metric definition by id. */
export function findMetric(
  metrics: readonly MetricDefinition[],
  id: string,
): MetricDefinition | undefined {
  return metrics.find((m) => m.id === id);
}

/**
 * Collapse a metric's trajectory to the single value that gets normalized and
 * scored, per its declared aggregation.
 */
export function aggregateMetric(
  definition: MetricDefinition,
  series: readonly number[],
): number {
  if (series.length === 0) return 0;
  switch (definition.aggregation) {
    case 'min':
      return series.reduce((a, b) => Math.min(a, b), series[0]);
    case 'max':
      return series.reduce((a, b) => Math.max(a, b), series[0]);
    case 'cumulative':
      // Series for cumulative metrics is already an accumulator, so the final
      // sample IS the total. Guard against a non-monotonic series by taking max.
      return series.reduce((a, b) => Math.max(a, b), series[0]);
    case 'final':
    default:
      return series[series.length - 1];
  }
}

/**
 * Map an aggregated value onto 0..1 where 1 is always "good", flipping the
 * scale for `minimize` metrics.
 */
export function normalizeMetric(definition: MetricDefinition, value: number): number {
  const { min, max } = definition.normalize;
  const span = max - min;
  if (span === 0) return 0;
  const raw = (value - min) / span;
  const clamped = Math.max(0, Math.min(1, raw));
  return definition.direction === 'minimize' ? 1 - clamped : clamped;
}

/** Interpret a before/after pair using the metric's own direction. */
export function toMetricDelta(
  definition: MetricDefinition,
  before: number,
  after: number,
): MetricDelta {
  const delta = after - before;
  const epsilon = definition.epsilon ?? 1e-6;
  let direction: MetricDelta['direction'] = 'neutral';
  if (Math.abs(delta) > epsilon) {
    const improved = definition.direction === 'minimize' ? delta < 0 : delta > 0;
    direction = improved ? 'better' : 'worse';
  }
  return { metric: definition.id, label: definition.label, before, after, delta, direction };
}

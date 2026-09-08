/**
 * Metric presentation (§7, §8).
 *
 * The runtime must show the metrics the COMPILED SCENARIO defines — with their
 * declared units — and nothing else. A generic logistics scenario has no
 * `temperature` metric, so the runtime must never render "TEMP" or "°C" for it.
 *
 * Formatting is derived from each `MetricDefinition` (unit + normalize range),
 * not from a per-metric switch scattered through the UI.
 */

import type { MetricDefinition, ScenarioConfig, StepMetrics } from '../domain';

/** Metrics the live status strip surfaces, in priority order, when defined. */
const STRIP_PRIORITY = [
  'viability',
  'temperature',
  'serviceCoverage',
  'delay',
  'cost',
  'risk',
  'exposure',
] as const;

export interface VisibleMetric {
  id: string;
  label: string;
  /** Short label for a tight strip cell (e.g. "Temp", "Coverage"). */
  shortLabel: string;
  definition: MetricDefinition;
}

const SHORT_LABEL: Record<string, string> = {
  serviceCoverage: 'Coverage',
  temperature: 'Temp',
  viability: 'Viability',
  delay: 'Delay',
  cost: 'Cost',
  risk: 'Risk',
  exposure: 'Exposure',
};

/**
 * The metrics to show in the runtime strip, chosen from the scenario's own
 * metric definitions. Capped so the strip stays readable.
 */
export function visibleStripMetrics(scenario: ScenarioConfig, limit = 4): VisibleMetric[] {
  const byId = new Map(scenario.metrics.map((m) => [String(m.id), m]));
  const out: VisibleMetric[] = [];
  for (const id of STRIP_PRIORITY) {
    const def = byId.get(id);
    if (!def) continue;
    out.push({
      id,
      label: def.label,
      shortLabel: SHORT_LABEL[id] ?? def.label,
      definition: def,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Does the scenario model this metric at all? */
export function scenarioHasMetric(scenario: ScenarioConfig, id: string): boolean {
  return scenario.metrics.some((m) => String(m.id) === id);
}

/**
 * Format one metric value using its definition. Percent metrics are detected by
 * unit `%`; a 0..1 normalized range means the raw value is a fraction and is
 * scaled, a 0..100 range means it is already a percentage.
 */
export function formatMetric(def: MetricDefinition, value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  const unit = def.unit ?? '';

  if (unit === '%') {
    const asPercent = def.normalize.max <= 1 ? value * 100 : value;
    return `${Math.round(asPercent)}%`;
  }
  if (unit === '°C') return `${value.toFixed(1)} °C`;
  if (unit === '°C·min') return `${Math.round(value)} °C·min`;
  if (unit === 'min') return `${Math.round(value)} min`;
  if (unit === '₹') return formatRupees(value);

  // Unitless (e.g. risk band 1..4): show one decimal against its ceiling.
  if (String(def.id) === 'risk') return `${value.toFixed(1)} / ${def.normalize.max}`;
  return value.toFixed(1);
}

/** Format a value already known to be `serviceCoverage` (0..1). */
export function formatCoverage(value: number | undefined): string {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Math.round(value * 100)}%`;
}

export function formatRupees(value: number): string {
  if (value >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
  if (value >= 1000) return `₹${(value / 1000).toFixed(0)}k`;
  return `₹${Math.round(value)}`;
}

/**
 * The metric that best expresses "did the operation succeed" for this scenario:
 * viability for cold-chain, otherwise service coverage. Used for the do-nothing
 * headline so a generic scenario never says "viability".
 */
export function primaryOutcomeMetric(scenario: ScenarioConfig): VisibleMetric | null {
  const byId = new Map(scenario.metrics.map((m) => [String(m.id), m]));
  const pick = byId.get('viability') ?? byId.get('serviceCoverage') ?? null;
  if (!pick) return null;
  return {
    id: String(pick.id),
    label: pick.label,
    shortLabel: SHORT_LABEL[String(pick.id)] ?? pick.label,
    definition: pick,
  };
}

/** "viability collapses to 41%" / "service coverage falls to 62%". */
export function describeDoNothing(scenario: ScenarioConfig, metrics: StepMetrics): string | null {
  const m = primaryOutcomeMetric(scenario);
  if (!m) return null;
  const value = metrics[m.id as keyof StepMetrics];
  if (value == null) return null;
  const verb = m.id === 'viability' ? 'collapses to' : 'falls to';
  return `${m.label.toLowerCase()} ${verb} ${formatMetric(m.definition, value)}`;
}

/**
 * §7 metric formatting + §8 no cold-chain leakage in generic runtime.
 */

import { describe, expect, it } from 'vitest';
import {
  compileScenarioGraph,
  genericLogisticsTemplate,
  pharmaTemplate,
} from '../../scenario';
import {
  formatCoverage,
  formatMetric,
  formatRupees,
  primaryOutcomeMetric,
  scenarioHasMetric,
  visibleStripMetrics,
  describeDoNothing,
} from '../metricFormat';
import type { MetricDefinition } from '../../domain';

const def = (over: Partial<MetricDefinition>): MetricDefinition => ({
  id: 'x',
  label: 'X',
  direction: 'maximize',
  aggregation: 'final',
  normalize: { min: 0, max: 1 },
  ...over,
});

describe('§7 — metric value formatting', () => {
  it('serviceCoverage 1.0 renders as 100%, not 1.0%', () => {
    expect(formatCoverage(1)).toBe('100%');
    expect(
      formatMetric(def({ id: 'serviceCoverage', unit: '%', normalize: { min: 0, max: 1 } }), 1),
    ).toBe('100%');
    expect(
      formatMetric(def({ id: 'serviceCoverage', unit: '%', normalize: { min: 0, max: 1 } }), 0.62),
    ).toBe('62%');
  });

  it('viability (0..100 range) renders as a whole percent', () => {
    expect(
      formatMetric(def({ id: 'viability', unit: '%', normalize: { min: 0, max: 100 } }), 91.4),
    ).toBe('91%');
  });

  it('temperature carries °C with one decimal', () => {
    expect(formatMetric(def({ id: 'temperature', unit: '°C', normalize: { min: 5, max: 26 } }), 13.84)).toBe(
      '13.8 °C',
    );
  });

  it('delay is whole minutes', () => {
    expect(formatMetric(def({ id: 'delay', unit: 'min', normalize: { min: 0, max: 90 } }), 12.6)).toBe(
      '13 min',
    );
  });

  it('cost is rupees, lakh-scaled past ₹1L', () => {
    expect(formatRupees(260000)).toBe('₹2.6L');
    expect(formatRupees(4200)).toBe('₹4k');
    expect(formatMetric(def({ id: 'cost', unit: '₹', normalize: { min: 0, max: 6e5 } }), 260000)).toBe('₹2.6L');
  });

  it('risk shows as a band out of its ceiling', () => {
    expect(formatMetric(def({ id: 'risk', unit: undefined, normalize: { min: 1, max: 4 } }), 2.3)).toBe(
      '2.3 / 4',
    );
  });

  it('a missing value is a dash, never NaN', () => {
    expect(formatMetric(def({ unit: '%' }), undefined)).toBe('—');
    expect(formatCoverage(undefined)).toBe('—');
  });
});

describe('§8 — generic runtime shows no cold-chain metrics', () => {
  const generic = compileScenarioGraph(genericLogisticsTemplate()).scenario!;
  const pharma = compileScenarioGraph(pharmaTemplate()).scenario!;

  it('generic scenario has no temperature / viability / exposure metrics', () => {
    expect(scenarioHasMetric(generic, 'temperature')).toBe(false);
    expect(scenarioHasMetric(generic, 'viability')).toBe(false);
    expect(scenarioHasMetric(generic, 'exposure')).toBe(false);
  });

  it('the strip metrics for a generic scenario are all scenario-defined and non-pharma', () => {
    const strip = visibleStripMetrics(generic);
    expect(strip.length).toBeGreaterThan(0);
    for (const vm of strip) {
      expect(['serviceCoverage', 'delay', 'cost', 'risk']).toContain(vm.id);
    }
  });

  it('primary outcome metric is serviceCoverage for generic, viability for pharma', () => {
    expect(primaryOutcomeMetric(generic)?.id).toBe('serviceCoverage');
    expect(primaryOutcomeMetric(pharma)?.id).toBe('viability');
  });

  it('the do-nothing line never says "viability" for a generic scenario', () => {
    const line = describeDoNothing(generic, { serviceCoverage: 0.4, delay: 30 });
    expect(line).toBeTruthy();
    expect(line!.toLowerCase()).not.toContain('viability');
    expect(line).toMatch(/service coverage/i);
  });

  it('pharma strip still leads with viability + temperature', () => {
    const strip = visibleStripMetrics(pharma).map((m) => m.id);
    expect(strip).toContain('viability');
    expect(strip).toContain('temperature');
  });
});

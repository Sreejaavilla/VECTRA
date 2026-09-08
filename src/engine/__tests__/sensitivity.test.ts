/**
 * Sensitivity analysis — the numbers must come from real evaluations, and the
 * two products (local influence, decision flips) must stay distinguishable.
 */

import { describe, expect, it } from 'vitest';
import { analyzeSensitivity, canonicalSerialize } from '../index';
import { coldChainScenario, makeInputs } from './fixtures';

function analyze(inputs = makeInputs()) {
  const outcome = analyzeSensitivity(coldChainScenario, inputs);
  if (!outcome.ok) throw new Error(`analyzeSensitivity failed: ${outcome.error.message}`);
  return outcome.value;
}

describe('sensitivity report', () => {
  const report = analyze();

  it('is deterministic', () => {
    expect(canonicalSerialize(analyze())).toBe(canonicalSerialize(report));
  });

  it('records the baseline it perturbed around', () => {
    expect(report.baselineStrategyId).toBe('emergency_interception');
    expect(report.baselineScore).toBeGreaterThan(0);
    expect(report.baselineLabel).toBe('Emergency Interception');
  });

  it('probes every resource and every objective', () => {
    const probed = report.probes.map((p) => p.inputId).sort();
    const expected = [
      ...coldChainScenario.resources.map((r) => r.id),
      ...coldChainScenario.objectives.map((o) => o.id),
    ].sort();
    expect(probed).toEqual(expected);
  });

  it('normalizes drivers to sum to 1', () => {
    const total = report.drivers.reduce((sum, d) => sum + d.weight, 0);
    expect(total).toBeCloseTo(1, 9);
  });

  it('ranks drivers descending', () => {
    const weights = report.drivers.map((d) => d.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it('keeps a driver row even when its influence is zero', () => {
    // Budget is not binding at ₹8L. That is a finding, so the row survives.
    const budget = report.drivers.find((d) => d.inputId === 'res-budget');
    expect(budget).toBeDefined();
    expect(budget!.weight).toBeCloseTo(0, 9);
  });

  it('stays within the interactive performance budget', () => {
    // ~29 evaluations, each a full 4-strategy decision.
    expect(report.evaluations).toBeLessThan(60);
  });
});

describe('local influence', () => {
  const report = analyze();

  it('ranks the support vehicle as the dominant driver', () => {
    expect(report.drivers[0].inputId).toBe('res-support-vehicle');
    expect(report.drivers[0].weight).toBeGreaterThan(0.4);
  });

  it('reports zero influence for an input that is not binding here', () => {
    for (const id of ['res-budget', 'res-cold-storage']) {
      const probe = report.probes.find((p) => p.inputId === id)!;
      expect(probe.influence, id).toBeCloseTo(0, 9);
    }
  });

  it('derives influence from real evaluations, not estimates', () => {
    for (const probe of report.probes) {
      expect(probe.samples.length).toBeGreaterThan(0);
      for (const sample of probe.samples) {
        expect(Number.isFinite(sample.winningScore)).toBe(true);
      }
    }
  });
});

describe('decision flips', () => {
  const report = analyze();

  it('finds a flip for an input with zero local influence', () => {
    // The whole point of separating the two measures: budget does not move the
    // score locally, yet there is a level below which the decision changes.
    const probe = report.probes.find((p) => p.inputId === 'res-budget')!;
    expect(probe.influence).toBeCloseTo(0, 9);
    expect(probe.flip).toBeDefined();
    expect(probe.flip!.direction).toBe('below');
    expect(Number(probe.flip!.value)).toBeLessThan(8);
  });

  it('flips to a different strategy when the support vehicle is withdrawn', () => {
    const probe = report.probes.find((p) => p.inputId === 'res-support-vehicle')!;
    expect(probe.flip).toEqual({
      value: false,
      from: 'emergency_interception',
      to: 'reroute_storage',
      toLabel: 'Reroute to Cold Storage',
      direction: 'toggle',
    });
  });

  it('flips to Hybrid Recovery when safety is prioritised heavily enough', () => {
    // Proof 3: the recommendation is genuinely a function of the operator's
    // priorities. Past a safety weight of ~0.55 the more expensive, higher-
    // viability Hybrid Recovery overtakes Emergency Interception.
    const probe = report.probes.find((p) => p.inputId === 'obj-safety')!;
    expect(probe.flip?.to).toBe('hybrid');
    expect(probe.flip?.direction).toBe('above');
  });

  it('flips toward Hybrid Recovery when cost stops mattering', () => {
    const probe = report.probes.find((p) => p.inputId === 'obj-cost')!;
    expect(probe.flip?.to).toBe('hybrid');
    expect(probe.flip?.direction).toBe('below');
  });

  it('reports the flip nearest the baseline, not merely any flip', () => {
    for (const probe of report.probes) {
      if (!probe.flip) continue;
      const flipped = probe.samples.filter(
        (s) => s.recommendedStrategyId !== report.baselineStrategyId,
      );
      const nearest = Math.min(
        ...flipped.map((s) => Math.abs(Number(s.value) - Number(probe.baselineValue))),
      );
      expect(Math.abs(Number(probe.flip.value) - Number(probe.baselineValue))).toBeCloseTo(
        nearest,
        9,
      );
    }
  });

  it('surfaces every probe flip in the top-level list', () => {
    const fromProbes = report.probes.filter((p) => p.flip).map((p) => p.flip);
    expect(report.flips).toEqual(fromProbes);
  });

  it('agrees with an actual re-evaluation at the flip point', () => {
    const probe = report.probes.find((p) => p.inputId === 'res-support-vehicle')!;
    const rerun = analyze(makeInputs({ resources: { 'res-support-vehicle': false } }));
    expect(rerun.baselineStrategyId).toBe(probe.flip!.to);
  });
});

describe('perturbation keeps inputs valid', () => {
  it('renormalizes objective weights so the engine never rejects a probe', () => {
    // A weight probe that broke the "sums to 1" rule would return score 0 for
    // every sample and silently look like zero influence.
    const report = analyze();
    for (const id of coldChainScenario.objectives.map((o) => o.id)) {
      const probe = report.probes.find((p) => p.inputId === id)!;
      const scored = probe.samples.filter((s) => s.winningScore > 0);
      expect(scored.length, id).toBeGreaterThan(0);
    }
  });

  it('rejects invalid inputs up front', () => {
    const outcome = analyzeSensitivity(coldChainScenario, {
      resources: {},
      constraints: {},
      priorities: { 'obj-safety': 0.9, 'obj-cost': 0.9 },
    });
    expect(outcome.ok).toBe(false);
  });
});

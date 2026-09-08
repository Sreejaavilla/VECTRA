/**
 * Aggregation, scoring and the recommendation's arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { aggregateTrajectory, metricSeries } from '../index';
import { coldChainScenario, evaluate, makeInputs, run } from './fixtures';

const metricsOf = (id: string) => coldChainScenario.metrics.find((m) => String(m.id) === id)!;

describe('trajectory aggregation honours each metric declaration', () => {
  const result = run('continue');
  const aggregated = aggregateTrajectory(result.steps, coldChainScenario.metrics);

  it('scores temperature on its PEAK, because peaks are what damage cargo', () => {
    expect(metricsOf('temperature').aggregation).toBe('max');
    expect(aggregated.temperature).toBeCloseTo(
      Math.max(...metricSeries(result.steps, 'temperature')),
      6,
    );
  });

  it('scores viability on its WORST dip, not its final value', () => {
    expect(metricsOf('viability').aggregation).toBe('min');
    expect(aggregated.viability).toBeCloseTo(
      Math.min(...metricSeries(result.steps, 'viability')),
      6,
    );
  });

  it('scores exposure cumulatively', () => {
    expect(metricsOf('exposure').aggregation).toBe('cumulative');
    expect(aggregated.exposure).toBeGreaterThan(0);
  });

  it('scores cost and delay on their final values', () => {
    const cost = metricSeries(result.steps, 'cost');
    expect(aggregated.cost).toBeCloseTo(cost[cost.length - 1], 6);
  });
});

describe('score arithmetic', () => {
  it('sums the contributions to the score, net of penalties', () => {
    const evaluation = evaluate();
    const recommendation = evaluation.recommendation!;
    const summed = recommendation.contributions.reduce((t, c) => t + c.contribution, 0);
    expect(summed - recommendation.penalty).toBeCloseTo(recommendation.score, 9);
  });

  it('computes each contribution as weight × normalized value', () => {
    const recommendation = evaluate().recommendation!;
    for (const contribution of recommendation.contributions) {
      expect(contribution.contribution).toBeCloseTo(
        contribution.weight * contribution.normalizedValue,
        9,
      );
      expect(contribution.normalizedValue).toBeGreaterThanOrEqual(0);
      expect(contribution.normalizedValue).toBeLessThanOrEqual(1);
    }
  });

  it('uses the input priorities as the effective weights', () => {
    const priorities = {
      'obj-safety': 0.7,
      'obj-speed': 0.1,
      'obj-cost': 0.1,
      'obj-risk': 0.1,
    };
    const recommendation = evaluate(makeInputs({ priorities }))!.recommendation!;
    const safety = recommendation.contributions.find((c) => c.objectiveId === 'obj-safety')!;
    expect(safety.weight).toBeCloseTo(0.7, 9);
  });
});

describe('the recommendation', () => {
  it('only ever recommends a feasible strategy', () => {
    const recommendation = evaluate().recommendation!;
    expect(evaluate().feasibleStrategies).toContain(recommendation.strategyId);
  });

  it('derives its reasons from the contributions', () => {
    const recommendation = evaluate().recommendation!;
    const objectiveReasons = recommendation.reasons.filter((r) => r.kind === 'objective');
    expect(objectiveReasons.length).toBeGreaterThan(0);
    for (const reason of objectiveReasons) {
      expect(reason.contribution).toBeDefined();
      expect(reason.text).toContain(reason.contribution!.contribution.toFixed(3));
    }
  });

  it('names the dominant driver first', () => {
    const recommendation = evaluate().recommendation!;
    const top = [...recommendation.contributions].sort(
      (a, b) => b.contribution - a.contribution,
    )[0];
    expect(recommendation.reasons[0].text).toContain(top.label);
    expect(recommendation.reasons[0].text).toContain('dominant driver');
  });

  it('accounts for every non-winning strategy', () => {
    const evaluation = evaluate();
    const rejected = evaluation.recommendation!.rejectedAlternatives;
    expect(rejected).toHaveLength(coldChainScenario.actions.length - 1);
    for (const alternative of rejected) expect(alternative.reason.length).toBeGreaterThan(0);
  });

  it('explains an infeasible rejection by its violation, not by its score', () => {
    const rejected = evaluate().recommendation!.rejectedAlternatives.find(
      (r) => r.strategyId === 'continue',
    )!;
    expect(rejected.feasible).toBe(false);
    expect(rejected.score).toBeUndefined();
    expect(rejected.reason).toMatch(/infeasible in flight/i);
  });

  it('explains a feasible rejection by the score gap', () => {
    const rejected = evaluate().recommendation!.rejectedAlternatives.find(
      (r) => r.strategyId === 'reroute_storage',
    )!;
    expect(rejected.feasible).toBe(true);
    expect(rejected.reason).toMatch(/Scores .* lower/);
  });

  it('changes the recommendation when priorities change', () => {
    const safetyFirst = evaluate(
      makeInputs({
        priorities: {
          'obj-safety': 0.7,
          'obj-speed': 0.1,
          'obj-cost': 0.1,
          'obj-risk': 0.1,
        },
      }),
    ).recommendation!;
    const costFirst = evaluate(
      makeInputs({
        priorities: {
          'obj-safety': 0.1,
          'obj-speed': 0.1,
          'obj-cost': 0.7,
          'obj-risk': 0.1,
        },
      }),
    ).recommendation!;
    expect(costFirst.strategyId).not.toBe(safetyFirst.strategyId);
  });

  it('falls back to a feasible strategy when the preferred resource disappears', () => {
    const withVehicle = evaluate().recommendation!;
    const withoutVehicle = evaluate(
      makeInputs({ resources: { 'res-support-vehicle': false } }),
    ).recommendation!;
    expect(withVehicle.strategyId).not.toBe(withoutVehicle.strategyId);
    expect(withoutVehicle.strategyId).toBe('reroute_storage');
  });

  it('returns no recommendation when nothing is feasible', () => {
    const evaluation = evaluate(
      makeInputs({ constraints: { 'constraint-critical-temperature': 5.5 } }),
    );
    expect(evaluation.recommendation).toBeNull();
    expect(evaluation.feasibleStrategies).toHaveLength(0);
  });
});

describe('decision impact', () => {
  it('judges a metric that carries no objective weight at all', () => {
    const impact = run('continue').decisionImpact!;
    const temperature = impact.changes.find((c) => c.metric === 'temperature')!;
    // Nothing optimises for temperature, yet it still gets a verdict — because
    // the verdict comes from the MetricDefinition, not from the objective list.
    expect(coldChainScenario.objectives.some((o) => o.metricId === 'temperature')).toBe(false);
    expect(temperature.after).toBeGreaterThan(temperature.before);
    expect(temperature.direction).toBe('worse');
  });

  it('derives every direction from its metric declaration', () => {
    for (const strategy of ['continue', 'emergency_interception', 'hybrid']) {
      const impact = run(strategy).decisionImpact!;
      for (const change of impact.changes) {
        const definition = coldChainScenario.metrics.find(
          (m) => String(m.id) === String(change.metric),
        )!;
        const epsilon = definition.epsilon ?? 1e-6;
        const expected =
          Math.abs(change.delta) <= epsilon
            ? 'neutral'
            : (definition.direction === 'minimize') === change.delta < 0
              ? 'better'
              : 'worse';
        expect(change.direction, `${strategy}/${String(change.metric)}`).toBe(expected);
      }
    }
  });

  it('marks a rising cost as worse', () => {
    const impact = run('emergency_interception').decisionImpact!;
    const cost = impact.changes.find((c) => c.metric === 'cost')!;
    expect(cost.delta).toBeGreaterThan(0);
    expect(cost.direction).toBe('worse');
  });

  it('computes delta as after - before', () => {
    const impact = run('hybrid').decisionImpact!;
    for (const change of impact.changes) {
      expect(change.delta).toBeCloseTo(change.after - change.before, 9);
    }
  });
});

describe('comparison', () => {
  it('runs every strategy from the same initial state', () => {
    const evaluation = evaluate();
    const firstSteps = evaluation.results.map((r) => r.steps[0]);
    for (const step of firstSteps) {
      expect(step.metrics.viability).toBeCloseTo(100, 6);
      expect(step.metrics.temperature).toBeCloseTo(
        firstSteps[0].metrics.temperature!,
        6,
      );
    }
  });

  it('leaves an earlier run untouched when a later one is produced', () => {
    const first = run('continue', makeInputs(), 1);
    const snapshot = JSON.stringify(first);
    run('hybrid', makeInputs(), 2);
    evaluate();
    expect(JSON.stringify(first)).toBe(snapshot);
  });

  it('keys runs distinctly', () => {
    const a = run('continue', makeInputs(), 1);
    const b = run('hybrid', makeInputs(), 2);
    expect(a.run.runId).not.toBe(b.run.runId);
  });
});

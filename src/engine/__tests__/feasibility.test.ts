/**
 * Two-level feasibility — the distinction the whole engine hangs on.
 *
 * Static feasibility is a property of the initial state and excludes a strategy
 * from being simulated at all. Trajectory feasibility is a property of the path
 * and can only be known afterwards; a strategy that passes every static check
 * can still become impossible in flight.
 */

import { describe, expect, it } from 'vitest';
import { evaluateScenario, runSimulation } from '../index';
import { coldChainScenario, evaluate, makeInputs, run } from './fixtures';

describe('static feasibility', () => {
  const noVehicle = makeInputs({ resources: { 'res-support-vehicle': false } });

  it('excludes an impossible strategy instead of scoring it badly', () => {
    const outcome = runSimulation(coldChainScenario, noVehicle, 'emergency_interception');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe('ConstraintViolation');
      expect(outcome.error.details?.some((d) => d.severity === 'hard')).toBe(true);
    }
  });

  it('reports it as statically infeasible, never as merely worse', () => {
    const evaluation = evaluate(noVehicle);
    expect(evaluation.feasibleStrategies).not.toContain('emergency_interception');
    const report = evaluation.infeasibleStrategies.find(
      (r) => r.strategyId === 'emergency_interception',
    )!;
    expect(report.staticFeasible).toBe(false);
    // Never simulated, so trajectory feasibility is unknown — not "true".
    expect(report.trajectoryFeasible).toBeNull();
    expect(evaluation.results.some((r) => r.strategy === 'emergency_interception')).toBe(false);
  });

  it('carries structured actual/expected on the violation', () => {
    const evaluation = evaluate(noVehicle);
    const report = evaluation.infeasibleStrategies.find(
      (r) => r.strategyId === 'emergency_interception',
    )!;
    const violation = report.violations.find((v) => v.severity === 'hard')!;
    expect(violation.scope).toBe('static');
    expect(violation.actual).toBe(0);
    expect(violation.message).toMatch(/support vehicle/i);
  });

  it('excludes a strategy whose resource requirement outruns supply', () => {
    const evaluation = evaluate(makeInputs({ resources: { 'res-cold-storage': 500 } }));
    // Full reroute needs 2,100 doses of storage; hybrid only needs 900.
    expect(evaluation.feasibleStrategies).not.toContain('reroute_storage');
    expect(evaluation.feasibleStrategies).not.toContain('hybrid');
  });

  it('leaves storage-independent strategies alone when storage is short', () => {
    const evaluation = evaluate(makeInputs({ resources: { 'res-cold-storage': 500 } }));
    expect(evaluation.feasibleStrategies).toContain('emergency_interception');
  });

  it('excludes every strategy the budget cannot cover', () => {
    const evaluation = evaluate(makeInputs({ resources: { 'res-budget': 1 } }));
    // Only `continue` is cheap enough to attempt at all...
    expect(evaluation.results.map((r) => r.strategy)).toEqual(['continue']);
    for (const strategy of ['reroute_storage', 'emergency_interception', 'hybrid']) {
      const report = evaluation.infeasibleStrategies.find((r) => r.strategyId === strategy)!;
      expect(report.staticFeasible).toBe(false);
    }
    // ...and it then breaches a hard limit in flight, so nothing is feasible.
    expect(evaluation.feasibleStrategies).toHaveLength(0);
    expect(evaluation.recommendation).toBeNull();
  });
});

describe('trajectory feasibility', () => {
  it('fails a strategy that is statically fine but breaches a hard limit in flight', () => {
    const result = run('continue');
    expect(result.feasibility.staticFeasible).toBe(true);
    expect(result.feasibility.trajectoryFeasible).toBe(false);
    expect(result.feasibility.feasible).toBe(false);
  });

  it('still returns the result, so the UI can show WHY it failed', () => {
    const evaluation = evaluate();
    const failing = evaluation.results.find((r) => r.strategy === 'continue')!;
    expect(failing).toBeDefined();
    expect(failing.steps.length).toBeGreaterThan(0);
    expect(evaluation.feasibleStrategies).not.toContain('continue');
  });

  it('records the minute of the first breach and the worst value reached', () => {
    const result = run('continue');
    const violation = result.violations.find(
      (v) => v.constraintId === 'constraint-critical-temperature',
    )!;
    expect(violation.scope).toBe('trajectory');
    expect(violation.severity).toBe('hard');
    expect(violation.atMinutes).toBeGreaterThan(35);
    expect(Number(violation.actual)).toBeGreaterThan(14);
    expect(violation.message).toMatch(/first breached at minute/);
  });

  it('emits a CONSTRAINT_VIOLATED event at the breach', () => {
    const result = run('continue');
    const event = result.events.find((e) => e.type === 'CONSTRAINT_VIOLATED');
    expect(event).toBeDefined();
    expect(event!.severity).toBe('critical');
  });

  it('treats soft trajectory breaches as penalties, not exclusions', () => {
    const result = run('emergency_interception');
    const soft = result.violations.filter((v) => v.severity === 'soft');
    expect(soft.length).toBeGreaterThan(0);
    expect(result.feasibility.feasible).toBe(true);
  });

  it('honours a tightened constraint supplied through inputs', () => {
    const strict = makeInputs({ constraints: { 'constraint-critical-temperature': 9 } });
    const result = run('emergency_interception', strict);
    expect(result.feasibility.feasible).toBe(false);
  });
});

describe('input and scenario validation', () => {
  it('rejects priorities that do not sum to 1', () => {
    const outcome = evaluateScenario(coldChainScenario, {
      resources: {},
      constraints: {},
      priorities: { 'obj-safety': 0.9, 'obj-cost': 0.9 },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('InvalidInput');
  });

  it('rejects an unknown resource', () => {
    const outcome = evaluateScenario(coldChainScenario, {
      resources: { 'res-nonexistent': 1 },
      constraints: {},
      priorities: {},
    });
    expect(outcome.ok).toBe(false);
  });

  it('rejects a negative resource', () => {
    const outcome = evaluateScenario(coldChainScenario, {
      resources: { 'res-budget': -1 },
      constraints: {},
      priorities: {},
    });
    expect(outcome.ok).toBe(false);
  });

  it('rejects an unknown strategy', () => {
    const outcome = runSimulation(coldChainScenario, makeInputs(), 'teleport-the-vaccines');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe('InvalidInput');
  });
});

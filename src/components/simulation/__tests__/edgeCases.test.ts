import { describe, expect, it } from 'vitest';
import type { ScenarioConfig, SimulationResult } from '../../../simulation/types';
import { coldChainScenario } from '../../../simulation/mockEngine';
import { getStateAtTime, getMetricSeries, getNarrativePhase } from '../../../simulation/selectors';

function makeResult(overrides: Partial<SimulationResult>): SimulationResult {
  const scenario: ScenarioConfig = coldChainScenario;
  const base: SimulationResult = {
    run: { runId: 'run-001', runNumber: 1, label: 'Test', inputs: {}, seed: 1 },
    scenario,
    strategy: 'continue',
    duration: 10,
    steps: [
      { timestamp: 0, entities: [], resources: [], metrics: { viability: 100 }, events: [] },
      { timestamp: 10, entities: [], resources: [], metrics: { viability: 100 }, events: [] },
    ],
    events: [],
    outcome: { strategy: 'Test', status: 'success', summary: 'ok', finalMetrics: {} },
  };
  return { ...base, ...overrides };
}

describe('edge cases', () => {
  it('handles a simulation with zero events', () => {
    const r = makeResult({ events: [] });
    expect(getNarrativePhase(r, 5)).toBe('NORMAL');
    expect(() => getStateAtTime(r, 5)).not.toThrow();
  });

  it('handles a single-step simulation', () => {
    const r = makeResult({
      steps: [{ timestamp: 0, entities: [], resources: [], metrics: { viability: 90 }, events: [] }],
    });
    const frame = getStateAtTime(r, 0);
    expect(frame.metrics.viability).toBe(90);
  });

  it('handles an immediate failure at t0', () => {
    const r = makeResult({
      events: [{ id: 'e1', timestamp: 0, type: 'FAILURE', eventClass: 'system', message: 'x' }],
    });
    expect(getNarrativePhase(r, 0)).toBe('FAILURE');
  });

  it('handles a very long duration', () => {
    const steps = Array.from({ length: 121 }, (_, i) => ({
      timestamp: i * 5,
      entities: [],
      resources: [],
      metrics: { viability: 100 - i * 0.5 },
      events: [],
    }));
    const r = makeResult({ duration: 600, steps });
    expect(getMetricSeries(r, 'viability').length).toBe(121);
    expect(() => getStateAtTime(r, 599)).not.toThrow();
  });

  it('handles an infeasible strategy result', () => {
    const r = makeResult({ outcome: { strategy: 'X', status: 'failed', summary: 'no', finalMetrics: {} } });
    expect(r.outcome.status).toBe('failed');
    expect(() => getStateAtTime(r, 5)).not.toThrow();
  });
});

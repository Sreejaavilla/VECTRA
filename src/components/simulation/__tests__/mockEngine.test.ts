import { describe, expect, it } from 'vitest';
import { coldChainScenario, runMockSimulation } from '../../../simulation/mockEngine';
import { classifyEvent } from '../../../simulation/selectors';

describe('runMockSimulation determinism', () => {
  it('produces byte-identical results for identical inputs (replay guarantee)', () => {
    const a = runMockSimulation(coldChainScenario, 'emergency_interception', { safetyPriority: 80 }, 3);
    const b = runMockSimulation(coldChainScenario, 'emergency_interception', { safetyPriority: 80 }, 3);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('changes outcome when inputs change', () => {
    const withVehicle = runMockSimulation(coldChainScenario, 'emergency_interception', {
      supportVehicleAvailable: true,
    });
    const without = runMockSimulation(coldChainScenario, 'emergency_interception', {
      supportVehicleAvailable: false,
    });
    expect(without.outcome.status).not.toBe(withVehicle.outcome.status);
  });
});

describe('runMockSimulation contract', () => {
  const result = runMockSimulation(coldChainScenario, 'reroute_storage');

  it('assigns an eventClass to every event', () => {
    for (const event of result.events) {
      expect(['system', 'decision']).toContain(classifyEvent(event));
    }
  });

  it('emits ascending, sorted event timestamps', () => {
    const ts = result.events.map((e) => e.timestamp);
    expect([...ts].sort((x, y) => x - y)).toEqual(ts);
  });

  it('decisionImpact.before matches metrics at the first decision event', () => {
    const impact = result.decisionImpact!;
    const decisionEvent = result.events.find((e) => e.id === impact.decisionEventId)!;
    const stepAt = result.steps.find((s) => s.timestamp >= decisionEvent.timestamp)!;
    expect(impact.before.viability).toBeCloseTo(stepAt.metrics.viability ?? -1, 5);
  });

  it('never lets viability increase across the run', () => {
    let prev = Infinity;
    for (const step of result.steps) {
      expect(step.metrics.viability!).toBeLessThanOrEqual(prev + 1e-6);
      prev = step.metrics.viability!;
    }
  });

  it('covers all four strategies without throwing', () => {
    for (const s of ['continue', 'reroute_storage', 'emergency_interception', 'hybrid'] as const) {
      const r = runMockSimulation(coldChainScenario, s);
      expect(r.steps.length).toBeGreaterThan(0);
      expect(r.events.some((e) => e.type === 'DELIVERY')).toBe(true);
    }
  });
});

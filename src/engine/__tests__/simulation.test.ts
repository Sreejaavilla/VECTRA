/**
 * The simulation itself: does the causal chain actually happen, and does it
 * happen because of state transitions rather than because someone keyframed it?
 */

import { describe, expect, it } from 'vitest';
import { COLD_CHAIN } from '../../simulation/scenarios/coldChain';
import { classifyEvent } from '../../simulation/selectors';
import { ALL_STRATEGIES, makeInputs, run } from './fixtures';

const at = (result: ReturnType<typeof run>, t: number) =>
  result.steps.find((s) => s.timestamp === t)!;

describe('the failure and its consequences', () => {
  const result = run('continue');

  it('emits the refrigeration failure at the scheduled minute', () => {
    const failure = result.events.find((e) => e.type === 'FAILURE');
    expect(failure?.timestamp).toBe(COLD_CHAIN.failureTimeMinutes);
  });

  it('holds temperature at baseline until the failure', () => {
    expect(at(result, 30).metrics.temperature).toBeCloseTo(COLD_CHAIN.baselineTemperature, 5);
  });

  it('raises temperature after the failure', () => {
    const before = at(result, 35).metrics.temperature!;
    const after = at(result, 65).metrics.temperature!;
    expect(after).toBeGreaterThan(before);
  });

  it('accumulates exposure only once past the safe temperature', () => {
    expect(at(result, 30).metrics.exposure).toBeCloseTo(0, 5);
    expect(at(result, 90).metrics.exposure!).toBeGreaterThan(0);
  });

  it('never lets viability increase — cargo does not un-spoil', () => {
    let previous = Infinity;
    for (const step of result.steps) {
      expect(step.metrics.viability!).toBeLessThanOrEqual(previous + 1e-9);
      previous = step.metrics.viability!;
    }
  });

  it('keeps viability inside [0, 100]', () => {
    for (const step of result.steps) {
      expect(step.metrics.viability!).toBeGreaterThanOrEqual(0);
      expect(step.metrics.viability!).toBeLessThanOrEqual(100);
    }
  });
});

describe('interventions bend the trajectory', () => {
  it('stabilises temperature after an interception', () => {
    const result = run('emergency_interception');
    const interception = result.events.find((e) => e.type === 'INTERCEPTION')!;
    const peak = Math.max(...result.steps.map((s) => s.metrics.temperature ?? 0));
    const final = result.steps[result.steps.length - 1].metrics.temperature!;
    expect(interception).toBeDefined();
    expect(final).toBeLessThan(peak);
  });

  it('an intervention beats doing nothing on viability', () => {
    const doNothing = run('continue');
    const intervene = run('emergency_interception');
    const worst = (r: ReturnType<typeof run>) =>
      Math.min(...r.steps.map((s) => s.metrics.viability ?? 100));
    expect(worst(intervene)).toBeGreaterThan(worst(doNothing));
  });

  it('produces materially different trajectories per strategy', () => {
    const peaks = ALL_STRATEGIES.map((s) =>
      Math.max(...run(s).steps.map((step) => step.metrics.temperature ?? 0)),
    );
    expect(new Set(peaks.map((p) => p.toFixed(1))).size).toBeGreaterThan(1);
  });
});

describe('resources and routing', () => {
  it('flips a resource from available to allocated when an action consumes it', () => {
    const result = run('emergency_interception');
    const vehicleAt = (t: number) =>
      at(result, t).resources.find((r) => r.id === 'res-support-vehicle')!;
    expect(vehicleAt(30).status).toBe('available');
    expect(vehicleAt(60).status).toBe('allocated');
  });

  it('spends budget only after the decision', () => {
    const result = run('reroute_storage');
    expect(at(result, 30).metrics.cost).toBe(0);
    expect(at(result, 60).metrics.cost!).toBeGreaterThan(0);
  });

  it('switches the shipment onto the storage route without teleporting it', () => {
    const result = run('reroute_storage');
    const truckAt = (t: number) => at(result, t).entities.find((e) => e.id === 'truck-01')!;
    expect(truckAt(35).routeId).toBe('route-hub-hospital-a');
    expect(truckAt(45).routeId).toBe('route-hub-storage');
    // Progress is re-solved from world position, never carried or reset to zero.
    expect(truckAt(45).progress).toBeGreaterThan(0.2);
  });

  it('delivers to both destinations', () => {
    const result = run('emergency_interception');
    const deliveries = result.events.filter((e) => e.type === 'DELIVERY');
    expect(deliveries.map((e) => e.facilityId).sort()).toEqual(['hospital-a', 'hospital-b']);
  });

  it('splits the shipment across two vehicles under the hybrid strategy', () => {
    const result = run('hybrid');
    const late = at(result, 80);
    const truck = late.entities.find((e) => e.id === 'truck-01')!;
    const support = late.entities.find((e) => e.id === 'support-01')!;
    expect(support.active).toBe(true);
    expect(truck.routeId).not.toBe(support.routeId);
    const deliveries = result.events.filter((e) => e.type === 'DELIVERY');
    expect(deliveries).toHaveLength(2);
  });
});

describe('event log contract', () => {
  const result = run('reroute_storage');

  it('assigns a resolvable class to every event', () => {
    for (const event of result.events) {
      expect(['system', 'decision']).toContain(classifyEvent(event));
    }
  });

  it('is sorted and unique by id', () => {
    const timestamps = result.events.map((e) => e.timestamp);
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
    expect(new Set(result.events.map((e) => e.id)).size).toBe(result.events.length);
  });

  it('is a superset of the per-step events', () => {
    const flattened = result.steps.flatMap((s) => s.events.map((e) => e.id));
    for (const id of flattened) {
      expect(result.events.some((e) => e.id === id)).toBe(true);
    }
  });

  it('anchors decisionImpact.before to the last step before the decision', () => {
    const impact = result.decisionImpact!;
    const decision = result.events.find((e) => e.id === impact.decisionEventId)!;
    const step = [...result.steps].reverse().find((s) => s.timestamp < decision.timestamp)!;
    expect(impact.before.viability).toBeCloseTo(step.metrics.viability!, 6);
    // The action's spend must NOT already be reflected in the "before" column.
    expect(impact.before.cost).toBe(0);
  });
});

describe('immutability', () => {
  it('freezes every step', () => {
    const result = run('continue');
    for (const step of result.steps) expect(Object.isFrozen(step)).toBe(true);
  });

  it('does not share mutable state between two runs', () => {
    const a = run('continue', makeInputs(), 1);
    const b = run('continue', makeInputs(), 2);
    expect(a.steps[5].metrics).not.toBe(b.steps[5].metrics);
    expect(a.steps[5].metrics).toEqual(b.steps[5].metrics);
  });
});

describe('resource accounting', () => {
  it('reports resources as available at t0, not depleted', () => {
    const result = run('emergency_interception');
    for (const resource of result.steps[0].resources) {
      expect(resource.status, resource.id).toBe('available');
    }
  });

  it('only reports depletion once a resource is actually exhausted', () => {
    const result = run('reroute_storage', makeInputs({ resources: { 'res-budget': 1.2 } }));
    const budgetAt = (t: number) =>
      at(result, t).resources.find((r) => r.id === 'res-budget')!;
    expect(budgetAt(0).status).toBe('available');
    expect(budgetAt(60).status).toBe('depleted');
  });
});

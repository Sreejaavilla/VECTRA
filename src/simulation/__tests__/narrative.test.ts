/**
 * The narrative presentation layer: technical events -> operator language,
 * constraint IDs -> operational pressure, and the decision-window projection.
 */

import { describe, expect, it } from 'vitest';
import {
  describeEvent,
  decisionWindow,
  incidentTimeline,
  translateViolation,
} from '../narrative';
import { makeColdChainScenario } from '../scenarios/coldChain';
import { runSimulation } from '../../engine';
import type { SimulationEvent } from '../types';

const ev = (over: Partial<SimulationEvent>): SimulationEvent => ({
  id: 'e',
  timestamp: 10,
  type: 'FAILURE',
  message: '',
  ...over,
});

describe('describeEvent', () => {
  it('maps every engine event type to a headline and tone', () => {
    const types = [
      'FAILURE',
      'THRESHOLD_CROSSED',
      'CONSTRAINT_VIOLATED',
      'VEHICLE_DISPATCHED',
      'RESOURCE_ALLOCATED',
      'REROUTE',
      'INTERCEPTION',
      'STORAGE_TRANSFER',
      'RECOVERY',
      'DELIVERY',
      'DECISION',
    ];
    for (const type of types) {
      const line = describeEvent(ev({ type }));
      expect(line.headline.length).toBeGreaterThan(0);
      expect(['normal', 'warning', 'critical', 'ok', 'decision']).toContain(line.tone);
    }
  });

  it('marks the critical moments for narration and stays quiet on the rest', () => {
    expect(describeEvent(ev({ type: 'FAILURE' })).speak).toBeDefined();
    expect(describeEvent(ev({ type: 'INTERCEPTION' })).speak).toBeDefined();
    expect(describeEvent(ev({ type: 'DELIVERY', message: 'delivered to Hospital A' })).speak).toBeDefined();
    // Routine events are not spoken.
    expect(describeEvent(ev({ type: 'RESOURCE_ALLOCATED' })).speak).toBeUndefined();
    expect(describeEvent(ev({ type: 'DELIVERY', message: '900 doses delivered to Hospital B' })).speak).toBeUndefined();
  });

  it('distinguishes a blockage CONSTRAINT_VIOLATED from a metric one', () => {
    expect(describeEvent(ev({ type: 'CONSTRAINT_VIOLATED', message: 'Route blockage — impassable' })).headline)
      .toMatch(/corridor unavailable/i);
  });
});

describe('translateViolation', () => {
  it('turns constraint ids into operational pressure', () => {
    const t = translateViolation({
      constraintId: 'constraint-critical-temperature',
      label: 'Critical temperature limit',
      severity: 'hard',
      scope: 'trajectory',
      actual: 18.2,
      expected: 14,
      message: 'raw',
    });
    expect(t.title).toBe('Cold-chain limit');
    expect(t.detail).toMatch(/18\.2/);
  });

  it('has a fallback for unknown constraints', () => {
    const t = translateViolation({
      constraintId: 'precondition:emergency:res-support-vehicle',
      label: 'Support vehicle',
      severity: 'hard',
      scope: 'static',
      actual: 0,
      expected: 1,
      message: 'no vehicle',
    });
    expect(t.title).toBe('Resource limit');
  });
});

describe('decisionWindow', () => {
  it('finds the minute the do-nothing plan breaches the cold-chain limit', () => {
    const scenario = makeColdChainScenario(); // failure at 35
    const run = runSimulation(scenario, { resources: {}, constraints: {}, priorities: {} }, 'continue');
    if (!run.ok) throw new Error(run.error.message);
    const w = decisionWindow(run.value.result);
    expect(w.breachAtMinutes).not.toBeNull();
    expect(w.breachAtMinutes!).toBeGreaterThan(35);
    expect(w.breachAtMinutes!).toBeLessThan(150);
  });

  it('reports no breach for the stable baseline', () => {
    const scenario = makeColdChainScenario({ refrigerationFailureAtMinutes: null });
    const run = runSimulation(scenario, { resources: {}, constraints: {}, priorities: {} }, 'monitor');
    if (!run.ok) throw new Error(run.error.message);
    expect(decisionWindow(run.value.result).breachAtMinutes).toBeNull();
  });
});

describe('incidentTimeline', () => {
  it('only includes events up to the given time', () => {
    const scenario = makeColdChainScenario();
    const run = runSimulation(scenario, { resources: {}, constraints: {}, priorities: {} }, 'reroute_storage');
    if (!run.ok) throw new Error(run.error.message);
    const early = incidentTimeline(run.value.result, 30);
    const late = incidentTimeline(run.value.result, 150);
    expect(early.length).toBeLessThan(late.length);
    expect(early.every((l) => l.atMinutes <= 30 + 1e-6)).toBe(true);
  });
});

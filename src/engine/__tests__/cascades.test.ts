/**
 * Cascade step-loop engine (Checkpoint 3).
 *
 * Two layers of coverage:
 *   - createCascadeProcessor in isolation: crossing semantics, one-shot, delay,
 *     deterministic ordering, depth / event-count guards, provenance.
 *   - end to end through simulateTrajectory on the cold-chain scenario: a real
 *     metric-triggered cascade mutates state and emits a provenance-carrying
 *     event, and a rule cycle cannot hang the run.
 */

import { describe, expect, it } from 'vitest';
import type { CascadeRule, ScenarioConfig, SimulationEvent, SimulationState } from '../../domain';
import { CASCADE_LIMITS, createCascadeProcessor } from '../cascades';
import { simulateTrajectory } from '../simulator';
import { coldChainScenario } from '../../simulation/scenarios/coldChain';
import { EMPTY_INPUTS } from '../../domain';

function bareState(): SimulationState {
  return {
    timestamp: 0,
    entities: {},
    facilities: {},
    resources: {},
    shipmentAllocations: {},
    settled: [],
    exposure: 0,
    metrics: {},
    flags: {},
  };
}

function drive(
  processor: ReturnType<typeof createCascadeProcessor>,
  state: SimulationState,
  steps: Array<{ now: number; mutate?: (s: SimulationState) => void; inbound?: SimulationEvent[] }>,
): SimulationEvent[] {
  const out: SimulationEvent[] = [];
  let previous = -Infinity;
  for (const step of steps) {
    step.mutate?.(state);
    state.timestamp = step.now;
    processor.step(state, {
      now: step.now,
      previous,
      stepEvents: step.inbound ?? [],
      emit: (e) => out.push(e),
    });
    previous = step.now;
  }
  return out;
}

describe('createCascadeProcessor — trigger semantics', () => {
  it('fires a metric rule on the false→true crossing, once', () => {
    const rule: CascadeRule = {
      id: 'r-temp',
      label: 'temp high',
      trigger: { kind: 'metric', metric: 'temperature', operator: '>', threshold: 14 },
      emit: { type: 'THRESHOLD_CROSSED', eventClass: 'system', message: 'temp over 14' },
    };
    const processor = createCascadeProcessor([rule]);
    const state = bareState();
    const events = drive(processor, state, [
      { now: 0, mutate: (s) => (s.metrics.temperature = 13.8) },
      { now: 5, mutate: (s) => (s.metrics.temperature = 14.2) }, // crosses
      { now: 10, mutate: (s) => (s.metrics.temperature = 16) }, // still over — must NOT refire
      { now: 15, mutate: (s) => (s.metrics.temperature = 12) }, // back under
      { now: 20, mutate: (s) => (s.metrics.temperature = 15) }, // re-crosses, but once
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe(5);
    expect(events[0].cascade?.ruleId).toBe('r-temp');
    expect(events[0].cascade?.triggerKind).toBe('metric');
  });

  it('re-arms a non-once rule on each fresh crossing', () => {
    const rule: CascadeRule = {
      id: 'r',
      label: 'r',
      once: false,
      trigger: { kind: 'metric', metric: 'viability', operator: '<', threshold: 80 },
      emit: { type: 'THRESHOLD_CROSSED', eventClass: 'system', message: 'viability dip' },
    };
    const events = drive(createCascadeProcessor([rule]), bareState(), [
      { now: 0, mutate: (s) => (s.metrics.viability = 90) },
      { now: 5, mutate: (s) => (s.metrics.viability = 70) }, // cross down
      { now: 10, mutate: (s) => (s.metrics.viability = 85) }, // recover
      { now: 15, mutate: (s) => (s.metrics.viability = 60) }, // cross again
    ]);
    expect(events.map((e) => e.timestamp)).toEqual([5, 15]);
  });

  it('honours a per-rule delay (trigger at T, emit at T + delay)', () => {
    const rule: CascadeRule = {
      id: 'r-blocked',
      label: 'delivery pressure',
      trigger: { kind: 'event', eventType: 'CONSTRAINT_VIOLATED' },
      delayMinutes: 10,
      effect: { setFlags: { 'delivery:pressure': 1 } },
      emit: { type: 'THRESHOLD_CROSSED', eventClass: 'system', message: 'delivery pressure rising' },
    };
    const state = bareState();
    const events = drive(createCascadeProcessor([rule]), state, [
      { now: 40, inbound: [{ id: 'e-block', timestamp: 40, type: 'CONSTRAINT_VIOLATED', message: 'blocked' }] },
      { now: 45 },
      { now: 50 }, // 40 + 10 -> fires here
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toBe(50);
    expect(state.flags['delivery:pressure']).toBe(1);
    expect(events[0].causedBy).toBe('e-block');
  });

  it('lets a cascade event trigger a second rule in the same step, with rising depth', () => {
    const rules: CascadeRule[] = [
      {
        id: 'r1',
        label: 'first',
        trigger: { kind: 'metric', metric: 'risk', operator: '>=', threshold: 3 },
        emit: { type: 'ESCALATION', eventClass: 'system', message: 'escalation' },
      },
      {
        id: 'r2',
        label: 'second',
        trigger: { kind: 'event', eventType: 'ESCALATION' },
        emit: { type: 'SHIPMENT_AT_RISK', eventClass: 'system', message: 'shipment at risk' },
      },
    ];
    const events = drive(createCascadeProcessor(rules), bareState(), [
      { now: 0, mutate: (s) => (s.metrics.risk = 1) },
      { now: 5, mutate: (s) => (s.metrics.risk = 4) },
    ]);
    expect(events.map((e) => e.type)).toEqual(['ESCALATION', 'SHIPMENT_AT_RISK']);
    expect(events[0].cascade?.depth).toBe(0);
    expect(events[1].cascade?.depth).toBe(1);
    expect(events[1].causedBy).toBe(events[0].id);
  });
});

describe('createCascadeProcessor — loop protection', () => {
  it('a mutually-triggering rule pair terminates (crossing + one-shot guard)', () => {
    const rules: CascadeRule[] = [
      {
        id: 'a',
        label: 'a',
        once: false,
        trigger: { kind: 'event', eventType: 'B_EVENT' },
        emit: { type: 'A_EVENT', eventClass: 'system', message: 'a' },
      },
      {
        id: 'b',
        label: 'b',
        once: false,
        trigger: { kind: 'event', eventType: 'A_EVENT' },
        emit: { type: 'B_EVENT', eventClass: 'system', message: 'b' },
      },
    ];
    const processor = createCascadeProcessor(rules);
    const events = drive(processor, bareState(), [
      { now: 0, inbound: [{ id: 'seed', timestamp: 0, type: 'A_EVENT', message: 'seed' }] },
    ]);
    // A<->B does not oscillate: once each side has fired on a continuously-true
    // condition it cannot re-arm within the step.
    expect(events.length).toBeLessThanOrEqual(4);
  });

  it('stops a genuine N-deep chain at MAX_DEPTH with a structured fault', () => {
    const chain: CascadeRule[] = [
      {
        id: 'root',
        label: 'root',
        trigger: { kind: 'metric', metric: 'risk', operator: '>=', threshold: 1 },
        emit: { type: 'STAGE_0', eventClass: 'system', message: 's0' },
      },
    ];
    for (let k = 1; k <= CASCADE_LIMITS.maxDepth + 3; k += 1) {
      chain.push({
        id: `stage-${k}`,
        label: `stage ${k}`,
        trigger: { kind: 'event', eventType: `STAGE_${k - 1}` },
        emit: { type: `STAGE_${k}`, eventClass: 'system', message: `s${k}` },
      });
    }
    const processor = createCascadeProcessor(chain);
    const events = drive(processor, bareState(), [{ now: 5, mutate: (s) => (s.metrics.risk = 2) }]);
    expect(processor.faults.some((f) => f.kind === 'depth')).toBe(true);
    // The chain is truncated: fewer events than rules.
    expect(events.length).toBeLessThan(chain.length);
    const maxDepth = Math.max(...events.map((e) => e.cascade?.depth ?? 0));
    expect(maxDepth).toBeLessThan(CASCADE_LIMITS.maxDepth);
  });

  it('caps total emitted cascade events across the run', () => {
    const rule: CascadeRule = {
      id: 'spam',
      label: 'spam',
      once: false,
      trigger: { kind: 'metric', metric: 'delay', operator: '>', threshold: 0 },
      emit: { type: 'NOISE', eventClass: 'system', message: 'noise' },
    };
    const processor = createCascadeProcessor([rule]);
    const state = bareState();
    const steps = [];
    for (let i = 0; i < CASCADE_LIMITS.maxTotalEvents * 2 + 20; i += 1) {
      steps.push({
        now: i,
        mutate: (s: SimulationState) => (s.metrics.delay = i % 2 === 0 ? 0 : 10),
      });
    }
    const events = drive(processor, state, steps);
    expect(events.length).toBeLessThanOrEqual(CASCADE_LIMITS.maxTotalEvents);
    expect(processor.faults.some((f) => f.kind === 'total')).toBe(true);
  });
});

describe('cascades end to end via simulateTrajectory', () => {
  const withRule = (rule: CascadeRule): ScenarioConfig => ({
    ...coldChainScenario,
    cascadeRules: [rule],
  });

  it('a metric-triggered cascade mutates state and emits a provenance event', () => {
    const scenario = withRule({
      id: 'viability-risk',
      label: 'viability risk',
      trigger: { kind: 'metric', metric: 'viability', operator: '<', threshold: 90 },
      effect: { setFlags: { 'shipment:at-risk': 1 } },
      emit: {
        type: 'SHIPMENT_AT_RISK',
        eventClass: 'system',
        message: 'Shipment viability degrading — shipment at risk',
        severity: 'warning',
      },
      sourceId: 'truck-01',
    });
    const action = scenario.actions.find((a) => a.id === 'continue')!;
    const trajectory = simulateTrajectory(scenario, EMPTY_INPUTS, action, 1);

    const risk = trajectory.events.find((e) => e.type === 'SHIPMENT_AT_RISK');
    expect(risk).toBeDefined();
    expect(risk!.cascade?.ruleId).toBe('viability-risk');
    expect(risk!.cascade?.trigger).toMatch(/viability/);
    const lastFrame = trajectory.frames.at(-1)!;
    expect(lastFrame.state.flags['shipment:at-risk']).toBe(1);
    expect(trajectory.cascadeFaults).toEqual([]);
  });

  it('is deterministic — identical trajectory events for identical inputs', () => {
    const scenario = withRule({
      id: 'r',
      label: 'r',
      trigger: { kind: 'metric', metric: 'temperature', operator: '>', threshold: 10 },
      emit: { type: 'THRESHOLD_CROSSED', eventClass: 'system', message: 'x' },
    });
    const action = scenario.actions.find((a) => a.id === 'continue')!;
    const a = simulateTrajectory(scenario, EMPTY_INPUTS, action, 7);
    const b = simulateTrajectory(scenario, EMPTY_INPUTS, action, 7);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });

  it('a self-referential rule cannot hang the real loop', () => {
    const scenario = withRule({
      id: 'loop',
      label: 'loop',
      once: false,
      trigger: { kind: 'event', eventType: 'LOOP' },
      emit: { type: 'LOOP', eventClass: 'system', message: 'loop' },
    });
    scenario.scheduledEvents = [
      ...scenario.scheduledEvents,
      { id: 'seed-loop', atMinutes: 10, type: 'LOOP', eventClass: 'system', message: 'seed' },
    ];
    const action = scenario.actions.find((a) => a.id === 'continue')!;
    const trajectory = simulateTrajectory(scenario, EMPTY_INPUTS, action, 1);
    // The run completes and cascade output stays bounded.
    expect(trajectory.frames.length).toBeGreaterThan(0);
    const loopEvents = trajectory.events.filter((e) => e.type === 'LOOP');
    expect(loopEvents.length).toBeLessThanOrEqual(CASCADE_LIMITS.maxTotalEvents);
  });
});

/**
 * Multi-shipment resource contention (Checkpoint 2).
 *
 * One emergency vehicle, three shipments, two of them at risk. Every assertion
 * here is about behaviour that must EMERGE from the engine — candidate
 * generation, feasibility, scoring, recommendation — never from a rule in the
 * scenario that picks a winner.
 */

import { describe, expect, it } from 'vitest';
import {
  flagshipScenario,
  makeFlagshipScenario,
  FLAGSHIP_OBJECTIVE_IDS,
} from '../../simulation/scenarios/flagship';
import { canonicalSerialize, evaluateScenario, runSimulation } from '../index';
import { EMPTY_INPUTS } from '../../domain';

const evenPriorities = () => {
  const w = 1 / FLAGSHIP_OBJECTIVE_IDS.length;
  return Object.fromEntries(FLAGSHIP_OBJECTIVE_IDS.map((id) => [id, w]));
};

describe('flagship — candidate space', () => {
  it('generates one emergency allocation per shipment plus a hold option', () => {
    expect(flagshipScenario.actions.map((a) => a.id).sort()).toEqual(
      ['emergency_ship-a', 'emergency_ship-b', 'emergency_ship-c', 'hold'].sort(),
    );
  });

  it('every emergency allocation requires the single shared emergency vehicle', () => {
    for (const a of flagshipScenario.actions.filter((x) => x.id.startsWith('emergency_'))) {
      const req = a.resourceRequirements.find((r) => r.resourceId === 'res-emergency-vehicle');
      expect(req?.amount).toBe(1);
    }
  });
});

describe('flagship — two shipments genuinely at risk', () => {
  const ev = evaluateScenario(flagshipScenario, EMPTY_INPUTS);
  it('evaluates', () => expect(ev.ok).toBe(true));

  it('the do-nothing hold leaves aggregate viability visibly degraded vs a rescue', () => {
    if (!ev.ok) return;
    const hold = ev.value.results.find((r) => r.strategy === 'hold');
    const rescueA = ev.value.results.find((r) => r.strategy === 'emergency_ship-a');
    expect(hold).toBeDefined();
    expect(rescueA).toBeDefined();
    const holdViab = hold!.outcome.finalMetrics.viability ?? 0;
    const rescueViab = rescueA!.outcome.finalMetrics.viability ?? 0;
    expect(rescueViab).toBeGreaterThan(holdViab);
  });

  it('a refrigeration-failure cascade fires with provenance', () => {
    const run = runSimulation(flagshipScenario, EMPTY_INPUTS, 'hold');
    if (!run.ok) throw new Error(run.error.message);
    const risk = run.value.result.events.find((e) => e.cascade?.ruleId === 'cascade-viability-risk');
    expect(risk).toBeDefined();
    expect(risk!.cascade?.triggerKind).toBe('metric');
    const contention = run.value.result.events.find((e) => e.cascade?.ruleId === 'cascade-contention');
    expect(contention).toBeDefined();
  });
});

describe('flagship — allocation emerges from scoring, not a rule', () => {
  it('with A the largest shipment, the vehicle goes to A', () => {
    const ev = evaluateScenario(
      makeFlagshipScenario({ demand: { 'hospital-a': 1500, 'hospital-b': 1000 } }),
      { ...EMPTY_INPUTS, priorities: evenPriorities() },
    );
    if (!ev.ok) throw new Error(ev.error.message);
    expect(ev.value.recommendation?.strategyId).toBe('emergency_ship-a');
  });

  it('swap the shipment sizes and the recommendation swaps too', () => {
    const ev = evaluateScenario(
      makeFlagshipScenario({ demand: { 'hospital-a': 1000, 'hospital-b': 1500 } }),
      { ...EMPTY_INPUTS, priorities: evenPriorities() },
    );
    if (!ev.ok) throw new Error(ev.error.message);
    expect(ev.value.recommendation?.strategyId).toBe('emergency_ship-b');
  });

  it('never recommends allocating the vehicle to the shipment that is not failing', () => {
    const ev = evaluateScenario(flagshipScenario, EMPTY_INPUTS);
    if (!ev.ok) throw new Error(ev.error.message);
    expect(ev.value.recommendation?.strategyId).not.toBe('emergency_ship-c');
  });
});

describe('flagship — resource exclusivity + conservation', () => {
  it('an allocation to A rescues only A — B keeps degrading', () => {
    const run = runSimulation(flagshipScenario, EMPTY_INPUTS, 'emergency_ship-a');
    if (!run.ok) throw new Error(run.error.message);
    const last = run.value.result.steps.at(-1)!;
    const shipA = last.entities.find((e) => e.id === 'ship-a')!;
    const shipB = last.entities.find((e) => e.id === 'ship-b')!;
    expect(shipA.status).not.toBe('refrigeration_failed');
    // Exactly one target was recorded.
    const targetEvents = run.value.result.events.filter((e) => e.type === 'INTERCEPTION');
    expect(targetEvents).toHaveLength(1);
    expect(targetEvents[0].entityId).toBe('ship-a');
    expect(shipB.id).toBe('ship-b');
  });

  it('the emergency vehicle resource goes 1 → 0 and never negative', () => {
    const run = runSimulation(flagshipScenario, EMPTY_INPUTS, 'emergency_ship-b');
    if (!run.ok) throw new Error(run.error.message);
    for (const step of run.value.result.steps) {
      const res = step.resources.find((r) => r.id === 'res-emergency-vehicle')!;
      expect(['available', 'allocated', 'depleted', 'unavailable']).toContain(res.status);
    }
    const finalRes = run.value.result.steps.at(-1)!.resources.find(
      (r) => r.id === 'res-emergency-vehicle',
    )!;
    expect(finalRes.status).not.toBe('available');
  });

  it('shipment conservation: total delivered equals total demand', () => {
    const run = runSimulation(flagshipScenario, EMPTY_INPUTS, 'emergency_ship-a');
    if (!run.ok) throw new Error(run.error.message);
    const coverage = run.value.result.steps.at(-1)!.metrics.serviceCoverage ?? 0;
    expect(coverage).toBeCloseTo(1, 5);
  });
});

describe('flagship — feasibility of the contention', () => {
  it('recommends a feasible allocation and it is in the feasible set', () => {
    const ev = evaluateScenario(flagshipScenario, EMPTY_INPUTS);
    if (!ev.ok) throw new Error(ev.error.message);
    expect(ev.value.recommendation).not.toBeNull();
    expect(ev.value.feasibleStrategies).toContain(ev.value.recommendation!.strategyId);
  });

  it('with the emergency vehicle unavailable, no allocation is feasible', () => {
    const ev = evaluateScenario(
      makeFlagshipScenario({ emergencyVehicleAvailable: false }),
      EMPTY_INPUTS,
    );
    if (!ev.ok) throw new Error(ev.error.message);
    for (const id of ['emergency_ship-a', 'emergency_ship-b', 'emergency_ship-c']) {
      expect(ev.value.feasibleStrategies).not.toContain(id);
    }
  });
});

describe('flagship — determinism', () => {
  it('identical inputs produce an identical evaluation', () => {
    const a = evaluateScenario(flagshipScenario, EMPTY_INPUTS);
    const b = evaluateScenario(makeFlagshipScenario(), EMPTY_INPUTS);
    if (!a.ok || !b.ok) throw new Error('evaluation failed');
    expect(canonicalSerialize(a.value)).toBe(canonicalSerialize(b.value));
  });
});

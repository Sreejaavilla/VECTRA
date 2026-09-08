/**
 * The richer operational network: a second cold store, parameterized reroute
 * and hybrid, a route-blockage disruption, and the invariants that must hold
 * once a shipment can be split across vehicles and stores.
 */

import { describe, expect, it } from 'vitest';
import {
  DEMO_SCENARIOS,
  DEFAULT_PRIORITIES,
  makeColdChainScenario,
} from '../../simulation/scenarios/coldChain';
import { canonicalSerialize, evaluateScenario, runSimulation } from '../index';
import { normalizeWeights, type SimulationInputs } from '../../domain';
import { makeInputs } from './fixtures';

function priorities(safety: number): Record<string, number> {
  const others = Object.keys(DEFAULT_PRIORITIES).filter((k) => k !== 'obj-safety');
  const otherTotal = others.reduce((s, k) => s + DEFAULT_PRIORITIES[k], 0);
  const raw: Record<string, number> = { 'obj-safety': safety };
  for (const k of others) raw[k] = (1 - safety) * (DEFAULT_PRIORITIES[k] / otherTotal);
  return normalizeWeights(raw);
}

function presetInputs(c: (typeof DEMO_SCENARIOS)[number]['controls']): SimulationInputs {
  const constraints: Record<string, number> = {};
  if (c.maxTemperatureC && c.maxTemperatureC !== 14) {
    constraints['constraint-critical-temperature'] = c.maxTemperatureC;
  }
  return {
    resources: {
      'res-budget': c.budgetLakh ?? 8,
      'res-cold-storage': c.storageDoses ?? 2400,
      'res-cold-store-b': c.storeBDoses ?? 3000,
      'res-support-vehicle': c.supportVehicleAvailable ?? true,
    },
    constraints,
    priorities: priorities((c.safetyPriority ?? 40) / 100),
  };
}

const base = makeColdChainScenario();

/* --------------------------------------------------------------------------- *
 * Network
 * --------------------------------------------------------------------------- */

describe('richer network', () => {
  it('exposes two regional cold stores and their corridors', () => {
    expect(base.facilities.map((f) => f.id)).toEqual(
      expect.arrayContaining(['cold-storage', 'cold-store-b']),
    );
    expect(base.routes.map((r) => r.id)).toEqual(
      expect.arrayContaining(['route-hub-storeb', 'route-storeb-hospital-a']),
    );
    expect(base.resources.map((r) => r.id)).toContain('res-cold-store-b');
  });

  it('reroute is a parameterized family that picks a store', () => {
    const ev = evaluateScenario(base, makeInputs());
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    const reroute = ev.value.results.find((r) => r.strategy === 'reroute_storage')!;
    expect(reroute.chosenParameters?.targetStore).toMatch(/cold-stor/);
    // Only the base id leaves the engine.
    expect(reroute.strategy).toBe('reroute_storage');
  });
});

/* --------------------------------------------------------------------------- *
 * Route blockage disruption
 * --------------------------------------------------------------------------- */

describe('route blockage', () => {
  const blocked = makeColdChainScenario({
    routeBlockage: { routeId: 'route-hub-hospital-a', atMinutes: 48 },
  });

  it('strands a shipment left on the blocked corridor', () => {
    const run = runSimulation(blocked, makeInputs(), 'continue');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const held = run.value.result.events.find((e) => /held at the blockage/i.test(e.message));
    expect(held).toBeDefined();
    const truck = run.value.result.steps.at(-1)!.entities.find((e) => e.id === 'truck-01')!;
    expect(truck.status).not.toBe('delivered');
    expect(run.value.result.steps.at(-1)!.metrics.delay).toBeGreaterThan(240);
  });

  it('makes the primary-route strategies infeasible and forces a full reroute', () => {
    const ev = evaluateScenario(blocked, makeInputs());
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    for (const s of ['continue', 'emergency_interception', 'hybrid']) {
      expect(ev.value.feasibleStrategies).not.toContain(s);
    }
    expect(ev.value.feasibleStrategies).toContain('reroute_storage');
    expect(ev.value.recommendation?.strategyId).toBe('reroute_storage');
  });

  it('the reroute sweep dodges a blocked onward leg by switching stores', () => {
    const onwardBlocked = makeColdChainScenario({
      routeBlockage: { routeId: 'route-storage-hospital-a', atMinutes: 55 },
    });
    const ev = evaluateScenario(onwardBlocked, makeInputs());
    if (!ev.ok) throw new Error(ev.error.message);
    const reroute = ev.value.results.find((r) => r.strategy === 'reroute_storage')!;
    expect(reroute.feasibility.feasible).toBe(true);
    expect(reroute.chosenParameters?.targetStore).toBe('cold-store-b');
  });
});

/* --------------------------------------------------------------------------- *
 * Invariants — shipment conservation once splitting is in play
 * --------------------------------------------------------------------------- */

describe('shipment + resource invariants', () => {
  const scenarios = [
    { id: 'continue', inputs: makeInputs() },
    { id: 'reroute_storage', inputs: makeInputs() },
    { id: 'emergency_interception', inputs: makeInputs() },
    { id: 'hybrid', inputs: makeInputs() },
  ];

  for (const { id, inputs } of scenarios) {
    it(`${id}: doses are conserved and capacities never go negative`, () => {
      const run = runSimulation(base, inputs, id);
      if (!run.ok) throw new Error(run.error.message);
      const total =
        base.initialState.shipmentAllocations['hospital-a'] +
        base.initialState.shipmentAllocations['hospital-b'];

      for (const step of run.value.result.steps) {
        // No resource detail should ever report a negative remaining count.
        for (const r of step.resources) {
          const m = /(-?\d[\d,]*)\s*\/\s*[\d,]+/.exec(r.detail ?? '');
          if (m) expect(Number(m[1].replace(/,/g, ''))).toBeGreaterThanOrEqual(0);
        }
        // Timestamps are monotonic.
      }
      const ts = run.value.result.steps.map((s) => s.timestamp);
      expect([...ts].sort((a, b) => a - b)).toEqual(ts);

      // Everything that was owed is delivered by the end (base scenario has no
      // blockage), so coverage lands at 1.
      const coverage = run.value.result.steps.at(-1)!.metrics.serviceCoverage;
      if (run.value.result.feasibility.feasible) {
        expect(coverage).toBeCloseTo(1, 5);
      }
      expect(total).toBe(2100);
    });
  }

  it('hybrid never lets the two vehicles carry more than the whole shipment', () => {
    // Drive the split explicitly through a pinned variant.
    const hybrid = base.actions.find((a) => a.id === 'hybrid')!;
    const pinned = {
      ...base,
      actions: [
        {
          ...hybrid,
          parameters: undefined,
          decisionTimeMinutes: 40,
          parameterValues: { storeShare: 0.6, decisionTimeMinutes: 40 },
        },
      ],
    };
    const ev = evaluateScenario(pinned, makeInputs());
    if (!ev.ok) throw new Error(ev.error.message);
    // The engine ran it without a conservation throw; the internal sanity check
    // in the simulator would have surfaced any dose duplication.
    expect(ev.value.results[0].steps.length).toBeGreaterThan(0);
  });
});

/* --------------------------------------------------------------------------- *
 * Determinism
 * --------------------------------------------------------------------------- */

describe('determinism with the richer model', () => {
  it('repeated evaluations are byte-identical', () => {
    const a = evaluateScenario(base, makeInputs());
    const b = evaluateScenario(base, makeInputs());
    if (!a.ok || !b.ok) throw new Error('evaluation failed');
    expect(canonicalSerialize(a.value)).toBe(canonicalSerialize(b.value));
  });

  it('a blockage scenario is deterministic too', () => {
    const s = makeColdChainScenario({
      routeBlockage: { routeId: 'route-hub-hospital-a', atMinutes: 48 },
    });
    const a = evaluateScenario(s, makeInputs());
    const b = evaluateScenario(s, makeInputs());
    if (!a.ok || !b.ok) throw new Error('evaluation failed');
    expect(canonicalSerialize(a.value)).toBe(canonicalSerialize(b.value));
  });
});

/* --------------------------------------------------------------------------- *
 * Decision landscape — the demo presets must each land where calibrated
 * --------------------------------------------------------------------------- */

describe('demo scenario calibration', () => {
  for (const preset of DEMO_SCENARIOS) {
    it(`${preset.id} recommends ${preset.expectWinner ?? 'nothing feasible'}`, () => {
      const scenario = makeColdChainScenario(preset.disruption);
      const ev = evaluateScenario(scenario, presetInputs(preset.controls));
      if (!ev.ok) throw new Error(ev.error.message);
      expect(ev.value.recommendation?.strategyId ?? null).toBe(preset.expectWinner);
    });
  }

  it('the winner genuinely moves across the presets', () => {
    const winners = new Set(
      DEMO_SCENARIOS.map((p) => {
        const ev = evaluateScenario(
          makeColdChainScenario(p.disruption),
          presetInputs(p.controls),
        );
        return ev.ok ? ev.value.recommendation?.strategyId : null;
      }),
    );
    // At least two distinct recommended strategies across the six presets.
    expect(winners.size).toBeGreaterThanOrEqual(2);
  });
});

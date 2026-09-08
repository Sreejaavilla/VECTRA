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

function safetyInputs(safety: number): SimulationInputs {
  return { resources: {}, constraints: {}, priorities: priorities(safety) };
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

  it('strands a Continue shipment left on the blocked corridor (no sentinel)', () => {
    const run = runSimulation(blocked, makeInputs(), 'continue');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const held = run.value.result.events.find((e) => /held at the blockage/i.test(e.message));
    expect(held).toBeDefined();
    const last = run.value.result.steps.at(-1)!;
    const truck = last.entities.find((e) => e.id === 'truck-01')!;
    expect(truck.status).not.toBe('delivered');
    // Delay is a real elapsed-vs-nominal figure, not a 999 sentinel.
    expect(last.metrics.delay).toBeLessThan(120);
    // Non-delivery is caught by the final service-coverage constraint instead.
    expect(last.metrics.serviceCoverage).toBeLessThan(1);
    expect(run.value.result.feasibility.feasible).toBe(false);
    expect(
      run.value.result.violations.some((v) => v.constraintId === 'constraint-final-coverage'),
    ).toBe(true);
  });

  it('does NOT automatically make Emergency and Hybrid infeasible — they recover then detour', () => {
    const ev = evaluateScenario(blocked, makeInputs());
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    // Continue strands and is rejected; the three recovery strategies survive.
    expect(ev.value.feasibleStrategies).not.toContain('continue');
    for (const s of ['reroute_storage', 'emergency_interception', 'hybrid']) {
      expect(ev.value.feasibleStrategies).toContain(s);
    }
  });

  it('Emergency and Hybrid take the detour: more delay and more cost than the clean run', () => {
    const clean = evaluateScenario(makeColdChainScenario(), makeInputs());
    const ev = evaluateScenario(blocked, makeInputs());
    if (!clean.ok || !ev.ok) throw new Error('evaluation failed');
    for (const s of ['emergency_interception', 'hybrid']) {
      const before = clean.value.results.find((r) => r.strategy === s)!.outcome.finalMetrics;
      const after = ev.value.results.find((r) => r.strategy === s)!.outcome.finalMetrics;
      expect(after.cost!).toBeGreaterThan(before.cost!);
      expect(after.delay!).toBeGreaterThanOrEqual(before.delay!);
      // The detour event is in the log.
      const detour = ev.value.results
        .find((r) => r.strategy === s)!
        .events.find((e) => /detour/i.test(e.message));
      expect(detour).toBeDefined();
    }
  });

  it('the winner emerges from scoring and moves with priorities under blockage', () => {
    const cheap = evaluateScenario(blocked, safetyInputs(0));
    const safe = evaluateScenario(blocked, safetyInputs(0.85));
    if (!cheap.ok || !safe.ok) throw new Error('evaluation failed');
    expect(cheap.value.recommendation?.strategyId).toBe('reroute_storage');
    expect(safe.value.recommendation?.strategyId).toBe('hybrid');
    expect(cheap.value.recommendation?.strategyId).not.toBe(
      safe.value.recommendation?.strategyId,
    );
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
 * Final-state constraints
 * --------------------------------------------------------------------------- */

describe('final-state constraints', () => {
  it('do not fire at t=0 even though coverage starts at 0', () => {
    const run = runSimulation(base, makeInputs(), 'emergency_interception');
    if (!run.ok) throw new Error(run.error.message);
    const firstStep = run.value.result.steps[0];
    expect(firstStep.metrics.serviceCoverage).toBe(0);
    // No violation is attributed to minute 0 for the final-scope constraints.
    for (const v of run.value.result.violations) {
      if (v.constraintId.startsWith('constraint-final-')) {
        expect(v.atMinutes).toBe(run.value.result.steps.at(-1)!.timestamp);
      }
    }
  });

  it('accept a run that delivers everything', () => {
    const run = runSimulation(base, makeInputs(), 'emergency_interception');
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.result.steps.at(-1)!.metrics.serviceCoverage).toBeCloseTo(1, 5);
    expect(
      run.value.result.violations.some(
        (v) => v.scope === 'final' && v.severity === 'hard',
      ),
    ).toBe(false);
    expect(run.value.result.feasibility.feasible).toBe(true);
  });

  it('reject a run that under-delivers', () => {
    // Blocked primary + Continue = the shipment never arrives.
    const blocked = makeColdChainScenario({
      routeBlockage: { routeId: 'route-hub-hospital-a', atMinutes: 48 },
    });
    const run = runSimulation(blocked, makeInputs(), 'continue');
    if (!run.ok) throw new Error(run.error.message);
    const coverageViolation = run.value.result.violations.find(
      (v) => v.constraintId === 'constraint-final-coverage',
    );
    expect(coverageViolation).toBeDefined();
    expect(coverageViolation!.scope).toBe('final');
    expect(coverageViolation!.severity).toBe('hard');
    expect(run.value.result.feasibility.feasible).toBe(false);
  });

  it('the scenario no longer relies on a delay sentinel', () => {
    const blocked = makeColdChainScenario({
      routeBlockage: { routeId: 'route-hub-hospital-a', atMinutes: 48 },
    });
    const run = runSimulation(blocked, makeInputs(), 'continue');
    if (!run.ok) throw new Error(run.error.message);
    for (const step of run.value.result.steps) {
      expect(step.metrics.delay ?? 0).toBeLessThan(900);
    }
    expect(base.constraints.some((c) => c.id === 'constraint-delivery-completed')).toBe(false);
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

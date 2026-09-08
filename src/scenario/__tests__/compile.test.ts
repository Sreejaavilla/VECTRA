/**
 * The architectural proof: a user-authored ScenarioGraph compiles to the
 * engine's ScenarioConfig and runs through the EXISTING engine — feasibility,
 * scoring, recommendation — with no hard-coded pharma references.
 */

import { describe, expect, it } from 'vitest';
import {
  blankGraph,
  compileScenarioGraph,
  createEdge,
  createNode,
  deserializeGraph,
  genericLogisticsTemplate,
  pharmaTemplate,
  serializeGraph,
  validateGraph,
  type ScenarioGraph,
} from '../index';
import { canonicalSerialize, evaluateScenario, runSimulation } from '../../engine';

const EMPTY_INPUTS = { resources: {}, constraints: {}, priorities: {} };

/* --------------------------------------------------------------------------- *
 * Graph model + serialization
 * --------------------------------------------------------------------------- */

describe('scenario graph', () => {
  it('round-trips through serialize / deserialize unchanged', () => {
    const g = genericLogisticsTemplate();
    const back = deserializeGraph(serializeGraph(g));
    expect(back.ok).toBe(true);
    expect(canonicalSerialize(back.graph)).toBe(canonicalSerialize(g));
  });

  it('assigns readable deterministic ids and names', () => {
    let g = blankGraph();
    const a = createNode(g, 'hospital', { x: 10, y: 10 });
    g = { ...g, nodes: [...g.nodes, a] };
    const b = createNode(g, 'hospital', { x: 20, y: 20 });
    expect(a.id).toBe('node-hospital-1');
    expect(b.id).toBe('node-hospital-2');
    expect(a.name).toBe('Hospital');
    expect(b.name).toBe('Hospital 2');
  });

  it('rejects a graph with no reachable destination', () => {
    let g = blankGraph();
    const src = createNode(g, 'factory', { x: 5, y: 5 });
    const dst = createNode({ ...g, nodes: [src] }, 'destination', { x: 90, y: 5 });
    g = {
      ...g,
      nodes: [src, dst],
      shipments: [
        {
          id: 'S1',
          label: 'S1',
          originId: src.id,
          destinationId: dst.id,
          quantity: 100,
          priority: 'normal',
          deadlineMinutes: 120,
          refrigerated: false,
        },
      ],
    };
    const v = validateGraph(g);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => /reachable/.test(i.message))).toBe(true);
  });

  it('rejects a route with non-positive travel time in readable language', () => {
    let g = blankGraph();
    const a = createNode(g, 'hub', { x: 5, y: 5 });
    const b = createNode({ ...g, nodes: [a] }, 'hospital', { x: 50, y: 5 });
    const edge = { ...createEdge(g, a.id, b.id), travelTimeMinutes: 0 };
    g = { ...g, nodes: [a, b], edges: [edge] };
    const v = validateGraph(g);
    expect(v.issues.some((i) => /travel time must be greater than zero/i.test(i.message))).toBe(true);
  });
});

/* --------------------------------------------------------------------------- *
 * GENERIC graph -> engine  (no pharma references anywhere)
 * --------------------------------------------------------------------------- */

describe('generic graph -> existing engine', () => {
  const graph = genericLogisticsTemplate();
  const compiled = compileScenarioGraph(graph);

  it('compiles without error', () => {
    expect(compiled.ok).toBe(true);
    expect(compiled.errors).toEqual([]);
  });

  it('produces a scenario with no pharma-specific identifiers', () => {
    const json = JSON.stringify(compiled.scenario, (_, v) =>
      typeof v === 'function' ? '[fn]' : v,
    );
    for (const banned of [
      'hospital-a',
      'hospital-b',
      'cold-store-b',
      'support-depot',
      'route-hub-hospital-a',
      'route-emergency',
      'route-hub-storage',
    ]) {
      expect(json.includes(`"${banned}"`)).toBe(false);
    }
    // No cold-chain step models either.
    expect(compiled.scenario!.stepModels.some((m) => m.id === 'model-temperature')).toBe(false);
    expect(compiled.scenario!.metrics.some((m) => m.id === 'temperature')).toBe(false);
  });

  it('runs a single strategy through the real engine and yields snapshots + metrics', () => {
    const run = runSimulation(compiled.scenario!, EMPTY_INPUTS, 'continue');
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const last = run.value.result.steps.at(-1)!;
    expect(run.value.result.steps.length).toBeGreaterThan(10);
    expect(typeof last.metrics.serviceCoverage).toBe('number');
    expect(typeof last.metrics.delay).toBe('number');
    expect(typeof last.metrics.cost).toBe('number');
  });

  it('evaluates the whole decision space and recommends a feasible strategy', () => {
    const ev = evaluateScenario(compiled.scenario!, EMPTY_INPUTS);
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    expect(ev.value.results.length).toBeGreaterThanOrEqual(2);
    // A blocked route in the template makes Continue miss its deadline / coverage;
    // the engine — not the compiler — decides the winner.
    expect(ev.value.recommendation).not.toBeNull();
    expect(ev.value.feasibleStrategies).toContain(ev.value.recommendation!.strategyId);
  });

  it('is deterministic', () => {
    const a = evaluateScenario(compiled.scenario!, EMPTY_INPUTS);
    const b = evaluateScenario(compileScenarioGraph(graph).scenario!, EMPTY_INPUTS);
    if (!a.ok || !b.ok) throw new Error('evaluation failed');
    expect(canonicalSerialize(a.value)).toBe(canonicalSerialize(b.value));
  });
});

/* --------------------------------------------------------------------------- *
 * A GRAPH EDIT changes the simulation result
 * --------------------------------------------------------------------------- */

describe('graph edits alter outcomes', () => {
  it('unblocking the route lets Continue succeed where it previously failed', () => {
    const blocked = genericLogisticsTemplate();
    const clear: ScenarioGraph = { ...blocked, incidents: [] };

    const evBlocked = evaluateScenario(
      compileScenarioGraph(blocked).scenario!,
      EMPTY_INPUTS,
    );
    const evClear = evaluateScenario(compileScenarioGraph(clear).scenario!, EMPTY_INPUTS);
    if (!evBlocked.ok || !evClear.ok) throw new Error('evaluation failed');

    const contBlocked = evBlocked.value.results.find((r) => r.strategy === 'continue')!;
    const contClear = evClear.value.results.find((r) => r.strategy === 'continue')!;
    // Same strategy, different world -> different feasibility / outcome.
    expect(contClear.feasibility.feasible).toBe(true);
    expect(contClear.outcome.finalMetrics.delay).not.toBe(contBlocked.outcome.finalMetrics.delay);
  });

  it('adding a parallel route creates a new reroute alternative', () => {
    const g = genericLogisticsTemplate();
    const before = compileScenarioGraph(g).info.alternatePaths;
    const extra = {
      ...createEdge(g, 'node-factory-1', 'node-destination-1'),
      id: 'edge-direct-express',
      travelTimeMinutes: 70,
      cost: 90000,
    };
    const withExtra: ScenarioGraph = { ...g, edges: [...g.edges, extra] };
    const after = compileScenarioGraph(withExtra).info.alternatePaths;
    expect(after).toBeGreaterThan(before);
  });
});

/* --------------------------------------------------------------------------- *
 * COLD-CHAIN template -> pharma scenario preserved
 * --------------------------------------------------------------------------- */

describe('pharma template regression', () => {
  const graph = pharmaTemplate();
  const compiled = compileScenarioGraph(graph);

  it('compiles the cold-chain template', () => {
    expect(compiled.ok).toBe(true);
    expect(compiled.scenario!.actions.map((a) => a.id).sort()).toEqual(
      ['continue', 'emergency_interception', 'hybrid', 'reroute_storage'].sort(),
    );
  });

  it('reproduces the calibrated pharma recommendation (Emergency at balanced priorities)', () => {
    const ev = evaluateScenario(compiled.scenario!, EMPTY_INPUTS);
    if (!ev.ok) throw new Error(ev.error.message);
    expect(ev.value.feasibleStrategies.sort()).toEqual(
      ['emergency_interception', 'hybrid', 'reroute_storage'].sort(),
    );
    expect(ev.value.recommendation!.strategyId).toBe('emergency_interception');
  });

  it('a graph edit — adding a hospital + shipment — flows into the engine', () => {
    let g = pharmaTemplate();
    const h = createNode(g, 'hospital', { x: 90, y: 30 });
    g = {
      ...g,
      nodes: [...g.nodes, h],
      edges: [
        ...g.edges,
        { ...createEdge(g, 'cold-store-b', h.id), id: 'edge-storeb-hd', travelTimeMinutes: 30 },
      ],
      shipments: [
        ...g.shipments,
        {
          id: 'VX-317',
          label: 'Second shipment',
          originId: 'hub',
          destinationId: h.id,
          quantity: 600,
          priority: 'high',
          deadlineMinutes: 130,
          refrigerated: true,
        },
      ],
    };
    const c = compileScenarioGraph(g);
    expect(c.ok).toBe(true);
    expect(c.scenario!.facilities.some((f) => f.id === h.id)).toBe(true);
    expect(c.scenario!.initialState.entities.some((e) => e.id === 'truck-02')).toBe(true);
    const run = runSimulation(c.scenario!, EMPTY_INPUTS, 'reroute_storage');
    expect(run.ok).toBe(true);
  });
});

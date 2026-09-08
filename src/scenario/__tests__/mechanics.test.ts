/**
 * New mechanics: time-triggered cascades, auto-layout determinism, generic
 * genericity proof, and the mandatory user-graph → engine integration test.
 */

import { describe, expect, it } from 'vitest';
import {
  autoLayout,
} from '../../components/build/layout';
import {
  blankGraph,
  compileScenarioGraph,
  createEdge,
  createNode,
  genericLogisticsTemplate,
  type ScenarioGraph,
} from '../index';
import { canonicalSerialize, evaluateScenario, runSimulation } from '../../engine';

const EMPTY = { resources: {}, constraints: {}, priorities: {} };

/* --------------------------------------------------------------------------- *
 * Cascades — time trigger compiles to a real scheduled event
 * --------------------------------------------------------------------------- */

describe('cascades', () => {
  it('a time-triggered cascade fires as a real engine event with its state effect', () => {
    const g = genericLogisticsTemplate();
    const withCascade: ScenarioGraph = {
      ...g,
      incidents: [],
      cascades: [
        {
          id: 'casc-1',
          when: { kind: 'time', atMinutes: 20 },
          conditions: [],
          delayMinutes: 5,
          emit: {
            type: 'CONSTRAINT_VIOLATED',
            message: 'Cross-dock congestion — a corridor is closed',
            severity: 'critical',
            blocksRoutes: ['edge-transferpoint1-destination1'],
          },
          once: true,
        },
      ],
    };
    const c = compileScenarioGraph(withCascade);
    expect(c.ok).toBe(true);
    const run = runSimulation(c.scenario!, EMPTY, 'continue');
    if (!run.ok) throw new Error(run.error.message);
    const cascadeEvent = run.value.result.events.find((e) => /congestion/i.test(e.message));
    expect(cascadeEvent).toBeDefined();
    expect(cascadeEvent!.timestamp).toBe(25); // 20 + 5 delay
  });

  it('a metric-triggered cascade compiles to a step-loop rule and fires with provenance', () => {
    const g = genericLogisticsTemplate();
    const withCascade: ScenarioGraph = {
      ...g,
      cascades: [
        {
          id: 'casc-delay',
          when: { kind: 'metric', metric: 'delay', op: '>', value: 5 },
          conditions: [],
          delayMinutes: 0,
          emit: {
            type: 'THRESHOLD_CROSSED',
            message: 'Delivery pressure rising — service level at risk',
            severity: 'warning',
          },
          once: true,
        },
      ],
    };
    const c = compileScenarioGraph(withCascade);
    expect(c.ok).toBe(true);
    expect(c.scenario!.cascadeRules?.some((r) => r.id === 'cascade-casc-delay')).toBe(true);
    const run = runSimulation(c.scenario!, EMPTY, 'continue');
    if (!run.ok) throw new Error(run.error.message);
    const fired = run.value.result.events.find((e) => /Delivery pressure rising/.test(e.message));
    expect(fired).toBeDefined();
    expect(fired!.cascade?.ruleId).toBe('cascade-casc-delay');
    expect(fired!.cascade?.triggerKind).toBe('metric');
    // Deterministic + bounded.
    expect(run.value.result.cascadeFaults ?? []).toEqual([]);
  });

  it('validates cascade references against the graph', () => {
    const g = blankGraph();
    const bad: ScenarioGraph = {
      ...g,
      cascades: [
        {
          id: 'c1',
          when: { kind: 'time', atMinutes: 10 },
          conditions: [],
          delayMinutes: 0,
          emit: { type: 'X', message: 'x', severity: 'info', blocksRoutes: ['nope'] },
          once: true,
        },
      ],
    };
    const c = compileScenarioGraph(bad);
    expect(c.ok).toBe(false);
  });
});

/* --------------------------------------------------------------------------- *
 * Auto-layout determinism
 * --------------------------------------------------------------------------- */

describe('auto-layout', () => {
  it('is deterministic for the same graph', () => {
    const g = genericLogisticsTemplate();
    expect(canonicalSerialize(autoLayout(g))).toBe(canonicalSerialize(autoLayout(g)));
  });

  it('places sources left of destinations', () => {
    const laid = autoLayout(genericLogisticsTemplate());
    const factory = laid.nodes.find((n) => n.id === 'node-factory-1')!;
    const retailer = laid.nodes.find((n) => n.id === 'node-destination-1')!;
    expect(factory.position.x).toBeLessThan(retailer.position.x);
  });
});

/* --------------------------------------------------------------------------- *
 * Genericity proof (§158) — a hand-built non-pharma graph
 * --------------------------------------------------------------------------- */

describe('non-pharma genericity', () => {
  function tinyGraph(): ScenarioGraph {
    let g = blankGraph();
    const factory = createNode(g, 'factory', { x: 10, y: 30 });
    g = { ...g, nodes: [factory] };
    const wh = createNode(g, 'warehouse', { x: 45, y: 30 });
    g = { ...g, nodes: [factory, wh] };
    const retailer = createNode(g, 'destination', { x: 85, y: 20 });
    g = { ...g, nodes: [factory, wh, retailer] };
    const alt = createNode(g, 'transfer-point', { x: 45, y: 52 });
    g = { ...g, nodes: [factory, wh, retailer, alt] };
    g = {
      ...g,
      edges: [
        createEdge(g, factory.id, wh.id),
        createEdge(g, wh.id, retailer.id),
        { ...createEdge(g, factory.id, alt.id), id: 'e-fa', travelTimeMinutes: 60 },
        { ...createEdge(g, alt.id, retailer.id), id: 'e-ar', travelTimeMinutes: 55 },
      ],
      shipments: [
        {
          id: 'ORD-1',
          label: 'Order 1',
          originId: factory.id,
          destinationId: retailer.id,
          quantity: 1000,
          priority: 'high',
          deadlineMinutes: 150,
          refrigerated: false,
        },
      ],
      incidents: [
        { id: 'blk', atMinutes: 25, type: 'route-blockage', targetId: 'edge-warehouse-1-destination-1', severity: 'high' },
      ],
      objective: 'maximize-service',
    };
    // Fix the blockage target to the actual generated edge id.
    const whToRetailer = g.edges.find((e) => e.from === wh.id && e.to === retailer.id)!;
    g = {
      ...g,
      incidents: [{ id: 'blk', atMinutes: 25, type: 'route-blockage', targetId: whToRetailer.id, severity: 'high' }],
    };
    return g;
  }

  it('simulates, detects the consequence, and recommends an action with no pharma model', () => {
    const c = compileScenarioGraph(tinyGraph());
    expect(c.ok).toBe(true);
    expect(c.scenario!.stepModels.some((m) => /temperature|viability/.test(m.id))).toBe(false);

    const ev = evaluateScenario(c.scenario!, EMPTY);
    if (!ev.ok) throw new Error(ev.error.message);
    // Continue can't cross the blocked corridor -> under-delivers -> infeasible.
    const cont = ev.value.results.find((r) => r.strategy === 'continue')!;
    expect(cont.feasibility.feasible).toBe(false);
    // The engine recommends the alternative path.
    expect(ev.value.recommendation?.strategyId).toBe('reroute');
  });
});

/* --------------------------------------------------------------------------- *
 * MANDATORY (§113): build a graph in the test, compile, run, evaluate.
 * --------------------------------------------------------------------------- */

describe('user graph -> engine (mandatory integration)', () => {
  it('supplier -> factory -> hub -> hospitals, 2 shipments, 1 emergency resource', () => {
    let g = { ...blankGraph(), durationMinutes: 260 };
    const supplier = createNode(g, 'supplier', { x: 6, y: 30 });
    g = { ...g, nodes: [supplier] };
    const factory = createNode(g, 'factory', { x: 28, y: 30 });
    g = { ...g, nodes: [supplier, factory] };
    const hub = createNode(g, 'hub', { x: 50, y: 30 });
    g = { ...g, nodes: [supplier, factory, hub] };
    const hA = createNode(g, 'hospital', { x: 85, y: 16 });
    g = { ...g, nodes: [supplier, factory, hub, hA] };
    const hB = createNode(g, 'hospital', { x: 85, y: 44 });
    g = { ...g, nodes: [supplier, factory, hub, hA, hB] };

    g = {
      ...g,
      edges: [
        createEdge(g, supplier.id, factory.id),
        createEdge(g, factory.id, hub.id),
        createEdge(g, hub.id, hA.id),
        createEdge(g, hub.id, hB.id),
        // A bypass so a reroute alternative exists when hub->A is blocked.
        { ...createEdge(g, factory.id, hA.id), id: 'e-bypass', travelTimeMinutes: 95, cost: 90000 },
      ],
      resources: [
        ...g.resources,
        { id: 'res-emergencyvehicle-1', label: 'Rapid Van', kind: 'emergency-vehicle', quantity: 1, unitCost: 0, available: true },
      ],
      shipments: [
        { id: 'S-A', label: 'To Hospital A', originId: supplier.id, destinationId: hA.id, quantity: 1200, priority: 'critical', deadlineMinutes: 160, refrigerated: false },
        { id: 'S-B', label: 'To Hospital B', originId: supplier.id, destinationId: hB.id, quantity: 800, priority: 'high', deadlineMinutes: 170, refrigerated: false },
      ],
      incidents: [{ id: 'i1', atMinutes: 30, type: 'route-blockage', targetId: '', severity: 'high' }],
    };
    const hubToA = g.edges.find((e) => e.from === hub.id && e.to === hA.id)!;
    g = { ...g, incidents: [{ id: 'i1', atMinutes: 30, type: 'route-blockage', targetId: hubToA.id, severity: 'high' }] };

    const compiled = compileScenarioGraph(g);
    expect(compiled.ok).toBe(true);

    // Both shipments become entities.
    expect(compiled.scenario!.initialState.entities.filter((e) => e.kind === 'shipment_vehicle').length).toBe(2);
    // Emergency resource -> an emergency action exists.
    expect(compiled.scenario!.actions.some((a) => a.id === 'emergency')).toBe(true);

    const single = runSimulation(compiled.scenario!, EMPTY, 'continue');
    expect(single.ok).toBe(true);
    if (single.ok) {
      expect(single.value.result.steps.length).toBeGreaterThan(10);
      expect(single.value.result.events.some((e) => e.type === 'CONSTRAINT_VIOLATED')).toBe(true);
    }

    const ev = evaluateScenario(compiled.scenario!, EMPTY);
    expect(ev.ok).toBe(true);
    if (ev.ok) {
      expect(ev.value.results.length).toBeGreaterThanOrEqual(2);
      expect(ev.value.recommendation).not.toBeNull();
    }
  });
});

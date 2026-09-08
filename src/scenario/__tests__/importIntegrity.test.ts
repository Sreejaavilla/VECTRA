/**
 * §1 regression — an imported ScenarioGraph defines the runtime world.
 *
 * A cold-chain graph the user authored (NOT the calibrated pharma template)
 * must compile to exactly its own nodes / edges / shipments / resources.
 * No built-in template entity may leak in.
 */

import { describe, expect, it } from 'vitest';
import { compileScenarioGraph, pharmaTemplate } from '../index';
import type { ScenarioGraph } from '../graph';
import { GRAPH_SCHEMA_VERSION } from '../graph';
import { EMPTY_INPUTS } from '../../domain';
import { evaluateScenario, runSimulation } from '../../engine';

/** 8 nodes, 10 edges, 3 refrigerated shipments — the flagship shape. */
function authoredColdChainGraph(): ScenarioGraph {
  return {
    id: 'authored-cold-chain',
    version: GRAPH_SCHEMA_VERSION,
    name: 'Authored Cold Chain',
    domainModel: 'cold-chain',
    durationMinutes: 160,
    timestepMinutes: 5,
    nodes: [
      { id: 'n-base', type: 'vehicle-base', name: 'Rapid Response Base', position: { x: 8, y: 6 }, props: { vehicleCount: 1 } },
      { id: 'n-hub', type: 'hub', name: 'Distribution Hub', position: { x: 8, y: 32 }, props: { handlingRatePerHr: 2000 } },
      { id: 'n-xdock', type: 'transfer-point', name: 'Emergency Cross-Dock', position: { x: 32, y: 8 }, props: {} },
      { id: 'n-csa', type: 'cold-storage', name: 'Cold Store A', position: { x: 38, y: 24 }, props: { capacity: 5000, occupied: 2600, temperatureLimitC: 8 } },
      { id: 'n-csb', type: 'cold-storage', name: 'Cold Store B', position: { x: 38, y: 44 }, props: { capacity: 3200, occupied: 1400, temperatureLimitC: 8 } },
      { id: 'n-north', type: 'hospital', name: 'Hospital North', position: { x: 84, y: 12 }, props: { demand: 1500, priority: 'critical', deadlineMinutes: 150 } },
      { id: 'n-east', type: 'hospital', name: 'Hospital East', position: { x: 84, y: 32 }, props: { demand: 600, priority: 'normal', deadlineMinutes: 150 } },
      { id: 'n-south', type: 'hospital', name: 'Hospital South', position: { x: 84, y: 52 }, props: { demand: 1000, priority: 'high', deadlineMinutes: 150 } },
    ],
    edges: [
      { id: 'e-hub-csa', from: 'n-hub', to: 'n-csa', travelTimeMinutes: 40, capacity: 3000, cost: 40000, available: true, temperatureRisk: 0.2 },
      { id: 'e-hub-csb', from: 'n-hub', to: 'n-csb', travelTimeMinutes: 45, capacity: 3000, cost: 45000, available: true, temperatureRisk: 0.2 },
      { id: 'e-csa-north', from: 'n-csa', to: 'n-north', travelTimeMinutes: 50, capacity: 2000, cost: 60000, available: true, temperatureRisk: 0.3 },
      { id: 'e-csa-east', from: 'n-csa', to: 'n-east', travelTimeMinutes: 45, capacity: 2000, cost: 55000, available: true, temperatureRisk: 0.3 },
      { id: 'e-csb-south', from: 'n-csb', to: 'n-south', travelTimeMinutes: 50, capacity: 2000, cost: 60000, available: true, temperatureRisk: 0.3 },
      { id: 'e-csb-east', from: 'n-csb', to: 'n-east', travelTimeMinutes: 40, capacity: 2000, cost: 52000, available: true, temperatureRisk: 0.3 },
      { id: 'e-csb-north', from: 'n-csb', to: 'n-north', travelTimeMinutes: 60, capacity: 2000, cost: 70000, available: true, temperatureRisk: 0.35 },
      { id: 'e-base-xdock', from: 'n-base', to: 'n-xdock', travelTimeMinutes: 15, capacity: 1500, cost: 30000, available: true, temperatureRisk: 0.1 },
      { id: 'e-xdock-north', from: 'n-xdock', to: 'n-north', travelTimeMinutes: 35, capacity: 1500, cost: 50000, available: true, temperatureRisk: 0.2 },
      { id: 'e-xdock-south', from: 'n-xdock', to: 'n-south', travelTimeMinutes: 40, capacity: 1500, cost: 52000, available: true, temperatureRisk: 0.2 },
    ],
    resources: [
      { id: 'res-vehicle-1', label: 'Standard Fleet', kind: 'vehicle', quantity: 2, unitCost: 0, available: true },
      { id: 'res-emergencyvehicle-1', label: 'Emergency Refrigerated Vehicle', kind: 'emergency-vehicle', quantity: 1, unitCost: 0, available: true },
      { id: 'res-budget', label: 'Recovery Budget', kind: 'budget', quantity: 8, unitCost: 100000, available: true },
    ],
    shipments: [
      { id: 'VX-204', label: 'Shipment VX-204', originId: 'n-hub', destinationId: 'n-north', quantity: 1500, priority: 'critical', deadlineMinutes: 150, refrigerated: true },
      { id: 'VX-317', label: 'Shipment VX-317', originId: 'n-hub', destinationId: 'n-south', quantity: 1000, priority: 'high', deadlineMinutes: 150, refrigerated: true },
      { id: 'VX-411', label: 'Shipment VX-411', originId: 'n-hub', destinationId: 'n-east', quantity: 600, priority: 'normal', deadlineMinutes: 150, refrigerated: true },
    ],
    incidents: [
      { id: 'inc-fail', atMinutes: 35, type: 'refrigeration-failure', severity: 'high' },
    ],
    cascades: [],
    constraints: [],
    objective: 'balanced',
  };
}

// `truck-0N` is the generic compiler's own entity-naming convention (asserted
// separately), so it is not a leakage signal. These ids only exist in the
// pharma template scenario.
const PHARMA_ONLY_IDS = [
  'hospital-a',
  'hospital-b',
  'cold-storage',
  'cold-store-b',
  'support-depot',
  'support-01',
  'route-hub-hospital-a',
  'route-emergency',
  'route-hub-storage',
  'Regional Cold Store A',
  'Regional Cold Store B',
];

describe('§1 — imported cold-chain graph is the runtime world', () => {
  const graph = authoredColdChainGraph();
  const compiled = compileScenarioGraph(graph);

  it('compiles', () => {
    expect(compiled.ok).toBe(true);
    expect(compiled.errors).toEqual([]);
  });

  it('compiles to exactly the 8 authored facilities — no template leakage', () => {
    const ids = compiled.scenario!.facilities.map((f) => f.id).sort();
    expect(ids).toEqual(graph.nodes.map((n) => n.id).sort());
    expect(compiled.scenario!.facilities).toHaveLength(8);
  });

  it('no pharma-template-only identifier appears anywhere in the compiled scenario', () => {
    const json = JSON.stringify(compiled.scenario, (_, v) => (typeof v === 'function' ? '[fn]' : v));
    for (const banned of PHARMA_ONLY_IDS) {
      expect(json.includes(`"${banned}"`)).toBe(false);
    }
  });

  it('keeps exactly 3 shipment entities, one per authored shipment', () => {
    const ships = compiled.scenario!.initialState.entities.filter((e) => e.kind === 'shipment_vehicle');
    expect(ships.map((e) => e.id).sort()).toEqual(['truck-01', 'truck-02', 'truck-03']);
    const demand = compiled.scenario!.initialState.shipmentAllocations;
    expect(demand['n-north']).toBe(1500);
    expect(demand['n-south']).toBe(1000);
    expect(demand['n-east']).toBe(600);
  });

  it('materialises routes only from the 10 authored edges', () => {
    const baseEdges = new Set(
      compiled.scenario!.routes.map((r) => (r.id.includes('@') ? r.id.slice(0, r.id.indexOf('@')) : r.id)),
    );
    for (const e of baseEdges) expect(graph.edges.some((ge) => ge.id === e)).toBe(true);
  });

  it('layers cold-chain physics on: temperature + viability models and hard limits', () => {
    expect(compiled.scenario!.stepModels.some((m) => m.id === 'model-temperature')).toBe(true);
    expect(compiled.scenario!.metrics.some((m) => m.id === 'viability')).toBe(true);
    expect(
      compiled.scenario!.constraints.some((c) => c.id === 'constraint-critical-temperature'),
    ).toBe(true);
  });

  it('runs through the real engine and produces a recommendation', () => {
    const run = runSimulation(compiled.scenario!, EMPTY_INPUTS, 'continue');
    expect(run.ok).toBe(true);
    const ev = evaluateScenario(compiled.scenario!, EMPTY_INPUTS);
    expect(ev.ok).toBe(true);
    if (ev.ok) expect(ev.value.recommendation).not.toBeNull();
  });

  it('runtime map entity count matches the compiled scenario', () => {
    const run = runSimulation(compiled.scenario!, EMPTY_INPUTS, 'continue');
    if (!run.ok) throw new Error(run.error.message);
    const mapEntities = run.value.result.steps[0].entities;
    expect(mapEntities).toHaveLength(compiled.scenario!.initialState.entities.length);
  });
});

describe('§47 — pharma template still uses the calibrated overlay path', () => {
  it('keeps the calibrated pharma actions and recommends Emergency Interception', () => {
    const compiled = compileScenarioGraph(pharmaTemplate());
    expect(compiled.scenario!.actions.map((a) => a.id).sort()).toEqual(
      ['continue', 'emergency_interception', 'hybrid', 'reroute_storage'].sort(),
    );
    const ev = evaluateScenario(compiled.scenario!, EMPTY_INPUTS);
    if (!ev.ok) throw new Error(ev.error.message);
    expect(ev.value.recommendation!.strategyId).toBe('emergency_interception');
  });
});

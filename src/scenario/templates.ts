/**
 * Scenario templates. The pharma cold-chain is derived from the calibrated
 * engine scenario so a template -> compile round trip reproduces it exactly.
 */

import { makeColdChainScenario } from '../simulation/scenarios/coldChain';
import type { GraphNode, GraphResource, GraphShipment, NodeType, ScenarioGraph } from './graph';
import { GRAPH_SCHEMA_VERSION } from './graph';

function nodeTypeFor(id: string, kind: string): NodeType {
  if (id.includes('hospital')) return 'hospital';
  if (id.includes('store') || id.includes('storage')) return 'cold-storage';
  if (id.includes('depot')) return 'vehicle-base';
  if (kind === 'destination') return 'hospital';
  if (kind === 'storage') return 'cold-storage';
  return 'hub';
}

export function pharmaTemplate(): ScenarioGraph {
  const s = makeColdChainScenario();

  const nodes: GraphNode[] = s.facilities.map((f) => {
    const type = nodeTypeFor(f.id, f.kind);
    const props: GraphNode['props'] = {};
    if (type === 'hospital') {
      props.demand = f.id === 'hospital-a' ? 1200 : 900;
      props.priority = f.id === 'hospital-a' ? 'critical' : 'normal';
      props.deadlineMinutes = 120;
      props.receivingCapacityPerHr = 300;
    } else if (type === 'cold-storage') {
      props.capacity = f.capacity?.capacity ?? 5000;
      props.occupied = f.capacity?.used ?? 2600;
      props.temperatureLimitC = 8;
    } else if (type === 'hub') {
      props.handlingRatePerHr = 2000;
    } else if (type === 'vehicle-base') {
      props.vehicleCount = 1;
    }
    return { id: f.id, type, name: f.label, position: { ...f.position }, props };
  });

  const edges = s.routes.map((r) => ({
    id: r.id,
    from: r.from,
    to: r.to,
    travelTimeMinutes: r.travelTimeMinutes ?? 45,
    capacity: 2100,
    cost: r.kind === 'emergency' ? 200000 : r.kind === 'reroute' ? 120000 : 0,
    available: !r.blocked,
    temperatureRisk: 0.25,
  }));

  const resources: GraphResource[] = [
    { id: 'res-support-vehicle', label: 'Refrigerated Support Vehicle', kind: 'emergency-vehicle', quantity: 1, unitCost: 0, available: true },
    { id: 'res-cold-storage', label: 'Cold Store A capacity', kind: 'storage', quantity: 2400, unitCost: 0, available: true },
    { id: 'res-cold-store-b', label: 'Cold Store B capacity', kind: 'storage', quantity: 3000, unitCost: 0, available: true },
    { id: 'res-budget', label: 'Recovery Budget', kind: 'budget', quantity: 8, unitCost: 100000, available: true },
  ];

  const shipments: GraphShipment[] = [
    {
      id: 'VX-204',
      label: 'Vaccine Shipment',
      originId: 'hub',
      destinationId: 'hospital-a',
      quantity: 2100,
      priority: 'critical',
      deadlineMinutes: 120,
      refrigerated: true,
    },
  ];

  return {
    id: 'pharma-cold-chain',
    version: GRAPH_SCHEMA_VERSION,
    name: 'Pharma Cold Chain',
    domainModel: 'cold-chain',
    durationMinutes: s.simulation.durationMinutes,
    timestepMinutes: s.simulation.timestepMinutes,
    nodes,
    edges,
    resources,
    shipments,
    incidents: [
      { id: 'inc-refrigeration', atMinutes: 35, type: 'refrigeration-failure', severity: 'high' },
    ],
    cascades: [],
    constraints: [],
    objective: 'balanced',
  };
}

/** Blank graph — the empty-state starting point. */
export function blankGraph(): ScenarioGraph {
  return {
    id: `scenario-${Date.now().toString(36)}`,
    version: GRAPH_SCHEMA_VERSION,
    name: 'New Operation',
    domainModel: 'generic',
    durationMinutes: 150,
    timestepMinutes: 5,
    nodes: [],
    edges: [],
    resources: [
      { id: 'res-budget', label: 'Budget', kind: 'budget', quantity: 8, unitCost: 100000, available: true },
    ],
    shipments: [],
    incidents: [],
    cascades: [],
    constraints: [],
    objective: 'balanced',
  };
}

/** A minimal non-pharma scenario — the generic-architecture proof. */
export function genericLogisticsTemplate(): ScenarioGraph {
  return {
    id: 'generic-logistics',
    version: GRAPH_SCHEMA_VERSION,
    name: 'Factory → Retailer',
    domainModel: 'generic',
    durationMinutes: 180,
    timestepMinutes: 5,
    nodes: [
      { id: 'node-factory-1', type: 'factory', name: 'Factory', position: { x: 10, y: 30 }, props: { productionCapacity: 3000, processingMinutes: 0 } },
      { id: 'node-warehouse-1', type: 'warehouse', name: 'Central Warehouse', position: { x: 40, y: 20 }, props: { capacity: 4000, occupied: 1000 } },
      { id: 'node-transferpoint-1', type: 'transfer-point', name: 'Cross-dock', position: { x: 42, y: 46 }, props: {} },
      { id: 'node-destination-1', type: 'destination', name: 'Retailer North', position: { x: 82, y: 16 }, props: { demand: 900, deadlineMinutes: 150 } },
      { id: 'node-destination-2', type: 'destination', name: 'Retailer South', position: { x: 82, y: 46 }, props: { demand: 600, deadlineMinutes: 150 } },
      { id: 'node-vehiclebase-1', type: 'vehicle-base', name: 'Fleet Depot', position: { x: 20, y: 6 }, props: { vehicleCount: 2 } },
    ],
    edges: [
      { id: 'edge-factory1-warehouse1', from: 'node-factory-1', to: 'node-warehouse-1', travelTimeMinutes: 40, capacity: 3000, cost: 50000, available: true, temperatureRisk: 0 },
      { id: 'edge-factory1-transferpoint1', from: 'node-factory-1', to: 'node-transferpoint-1', travelTimeMinutes: 55, capacity: 2000, cost: 40000, available: true, temperatureRisk: 0 },
      { id: 'edge-warehouse1-destination1', from: 'node-warehouse-1', to: 'node-destination-1', travelTimeMinutes: 50, capacity: 2000, cost: 60000, available: true, temperatureRisk: 0 },
      { id: 'edge-warehouse1-destination2', from: 'node-warehouse-1', to: 'node-destination-2', travelTimeMinutes: 65, capacity: 2000, cost: 65000, available: true, temperatureRisk: 0 },
      { id: 'edge-transferpoint1-destination1', from: 'node-transferpoint-1', to: 'node-destination-1', travelTimeMinutes: 45, capacity: 1500, cost: 55000, available: true, temperatureRisk: 0 },
      { id: 'edge-transferpoint1-destination2', from: 'node-transferpoint-1', to: 'node-destination-2', travelTimeMinutes: 35, capacity: 1500, cost: 50000, available: true, temperatureRisk: 0 },
    ],
    resources: [
      { id: 'res-vehicle-1', label: 'Delivery Fleet', kind: 'vehicle', quantity: 2, unitCost: 0, available: true },
      { id: 'res-emergencyvehicle-1', label: 'Rapid Response Van', kind: 'emergency-vehicle', quantity: 1, unitCost: 0, available: true },
      { id: 'res-budget', label: 'Operating Budget', kind: 'budget', quantity: 8, unitCost: 100000, available: true },
    ],
    shipments: [
      { id: 'ORD-901', label: 'Retailer North order', originId: 'node-factory-1', destinationId: 'node-destination-1', quantity: 900, priority: 'high', deadlineMinutes: 150, refrigerated: false },
      { id: 'ORD-902', label: 'Retailer South order', originId: 'node-factory-1', destinationId: 'node-destination-2', quantity: 600, priority: 'normal', deadlineMinutes: 160, refrigerated: false },
    ],
    incidents: [
      { id: 'inc-blockage', atMinutes: 30, type: 'route-blockage', targetId: 'edge-warehouse1-destination1', severity: 'high' },
    ],
    cascades: [],
    constraints: [{ id: 'c-service', metric: 'serviceCoverage', operator: '>=', value: 0.999, scope: 'final', severity: 'hard' }],
    objective: 'balanced',
  };
}

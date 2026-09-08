/**
 * ScenarioGraph — the declarative operational world a user authors.
 *
 * PURE DATA. No functions, no React, no DOM, no closures. It is serialized to
 * JSON verbatim. The compiler (`compile.ts`) turns it into the engine's
 * `ScenarioConfig`; the engine does every calculation.
 *
 * Identity rule: every object carries a stable string id. Nothing is referenced
 * by array position. Ids survive a serialize/deserialize round trip unchanged.
 */

export type NodeType =
  | 'hub'
  | 'supplier'
  | 'factory'
  | 'warehouse'
  | 'cold-storage'
  | 'hospital'
  | 'destination'
  | 'transfer-point'
  | 'vehicle-base';

/** Node properties are a flat, type-dependent bag — the inspector shows only
 *  the keys relevant to the node's type (see `NODE_PROPERTY_SCHEMA`). */
export type NodeProps = Record<string, number | string | boolean>;

export interface GraphNode {
  id: string;
  type: NodeType;
  name: string;
  /** Map space: 0..100 (x) by 0..60 (y), matching the operational map viewBox. */
  position: { x: number; y: number };
  props: NodeProps;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  travelTimeMinutes: number;
  capacity: number;
  /** Rupees to move a shipment across this corridor. */
  cost: number;
  available: boolean;
  /** 0..1 — how much this corridor warms refrigerated cargo (cold-chain only). */
  temperatureRisk: number;
}

export type ResourceKind = 'vehicle' | 'emergency-vehicle' | 'storage' | 'budget' | 'staff';

export interface GraphResource {
  id: string;
  label: string;
  kind: ResourceKind;
  /** Count for discrete resources; capacity for storage; ₹lakh for budget. */
  quantity: number;
  /** ₹ per unit consumed. */
  unitCost: number;
  available: boolean;
}

export type ShipmentPriority = 'critical' | 'high' | 'normal';

export interface GraphShipment {
  id: string;
  label: string;
  originId: string;
  destinationId: string;
  quantity: number;
  priority: ShipmentPriority;
  deadlineMinutes: number;
  /** Cold-chain: cargo needs active refrigeration. */
  refrigerated: boolean;
}

export type IncidentType =
  | 'refrigeration-failure'
  | 'route-blockage'
  | 'resource-unavailable'
  | 'storage-reduction';

export interface GraphIncident {
  id: string;
  atMinutes: number;
  type: IncidentType;
  /** Node / edge / resource / shipment id, per incident type. Optional for
   *  refrigeration-failure (defaults to the primary shipment). */
  targetId?: string;
  severity: 'low' | 'medium' | 'high';
}

/* --- Cascades: EVENT -> CONSEQUENCE -> CONDITION -> NEW EVENT ------------- */

export type CascadeTrigger =
  | { kind: 'event'; eventType: string }
  | { kind: 'time'; atMinutes: number }
  | { kind: 'metric'; metric: string; op: '<' | '<=' | '>' | '>='; value: number };

export type CascadeCondition =
  | { kind: 'metric'; metric: string; op: '<' | '<=' | '>' | '>='; value: number }
  | { kind: 'shipmentPriority'; equals: ShipmentPriority }
  | { kind: 'resourceAvailable'; resourceId: string; equals: boolean };

export interface GraphCascadeRule {
  id: string;
  when: CascadeTrigger;
  conditions: CascadeCondition[];
  delayMinutes: number;
  emit: {
    type: string;
    message: string;
    severity: 'info' | 'warning' | 'critical';
    /** Optional real state effects. */
    blocksRoutes?: string[];
    setFlags?: Record<string, number | string | boolean>;
  };
  once: boolean;
}

export type ConstraintMetric =
  | 'temperature'
  | 'viability'
  | 'delay'
  | 'cost'
  | 'serviceCoverage'
  | 'risk';

export interface GraphConstraint {
  id: string;
  metric: ConstraintMetric;
  operator: '<' | '<=' | '>' | '>=';
  value: number;
  scope: 'static' | 'trajectory' | 'final';
  severity: 'hard' | 'soft';
}

export type ObjectivePreset =
  | 'protect-product'
  | 'balanced'
  | 'minimize-cost'
  | 'maximize-service';

export type DomainModel = 'generic' | 'cold-chain';

export interface ScenarioGraph {
  id: string;
  version: number;
  name: string;
  domainModel: DomainModel;
  durationMinutes: number;
  timestepMinutes: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  resources: GraphResource[];
  shipments: GraphShipment[];
  incidents: GraphIncident[];
  cascades: GraphCascadeRule[];
  constraints: GraphConstraint[];
  objective: ObjectivePreset;
}

/* --------------------------------------------------------------------------- *
 * Property schema — drives the inspector. Nothing here is domain calculation.
 * --------------------------------------------------------------------------- */

export interface PropertyField {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'boolean' | 'select';
  options?: string[];
  unit?: string;
  default: number | string | boolean;
}

export const NODE_PROPERTY_SCHEMA: Record<NodeType, PropertyField[]> = {
  hub: [
    { key: 'handlingRatePerHr', label: 'Handling rate', kind: 'number', unit: '/hr', default: 2000 },
  ],
  supplier: [
    { key: 'supplyCapacity', label: 'Supply capacity', kind: 'number', unit: 'units', default: 5000 },
    { key: 'leadTimeMinutes', label: 'Lead time', kind: 'number', unit: 'min', default: 0 },
  ],
  factory: [
    { key: 'productionCapacity', label: 'Production capacity', kind: 'number', unit: 'units', default: 3000 },
    { key: 'processingMinutes', label: 'Processing time', kind: 'number', unit: 'min', default: 0 },
  ],
  warehouse: [
    { key: 'capacity', label: 'Capacity', kind: 'number', unit: 'units', default: 4000 },
    { key: 'occupied', label: 'Occupied', kind: 'number', unit: 'units', default: 0 },
  ],
  'cold-storage': [
    { key: 'capacity', label: 'Capacity', kind: 'number', unit: 'doses', default: 5000 },
    { key: 'occupied', label: 'Occupied', kind: 'number', unit: 'doses', default: 2600 },
    { key: 'temperatureLimitC', label: 'Temperature limit', kind: 'number', unit: '°C', default: 8 },
  ],
  hospital: [
    { key: 'demand', label: 'Demand', kind: 'number', unit: 'units', default: 800 },
    { key: 'priority', label: 'Priority', kind: 'select', options: ['critical', 'high', 'normal'], default: 'high' },
    { key: 'deadlineMinutes', label: 'Deadline', kind: 'number', unit: 'min', default: 120 },
    { key: 'receivingCapacityPerHr', label: 'Receiving capacity', kind: 'number', unit: '/hr', default: 300 },
  ],
  destination: [
    { key: 'demand', label: 'Demand', kind: 'number', unit: 'units', default: 500 },
    { key: 'deadlineMinutes', label: 'Deadline', kind: 'number', unit: 'min', default: 120 },
  ],
  'transfer-point': [],
  'vehicle-base': [
    { key: 'vehicleCount', label: 'Vehicles based here', kind: 'number', default: 1 },
  ],
};

/* --------------------------------------------------------------------------- *
 * Deterministic id + name generation
 * --------------------------------------------------------------------------- */

function slug(type: NodeType): string {
  return type.replace(/-/g, '');
}

/** Next stable id for a kind, e.g. `node-hospital-3`. Deterministic given the graph. */
export function nextNodeId(graph: ScenarioGraph, type: NodeType): string {
  const prefix = `node-${slug(type)}-`;
  let n = 1;
  while (graph.nodes.some((x) => x.id === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function nextEdgeId(graph: ScenarioGraph, from: string, to: string): string {
  const base = `edge-${from.replace('node-', '')}-${to.replace('node-', '')}`;
  if (!graph.edges.some((e) => e.id === base)) return base;
  let n = 2;
  while (graph.edges.some((e) => e.id === `${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const TYPE_LABEL: Record<NodeType, string> = {
  hub: 'Hub',
  supplier: 'Supplier',
  factory: 'Factory',
  warehouse: 'Warehouse',
  'cold-storage': 'Cold Store',
  hospital: 'Hospital',
  destination: 'Destination',
  'transfer-point': 'Transfer Point',
  'vehicle-base': 'Vehicle Base',
};

export function nextNodeName(graph: ScenarioGraph, type: NodeType): string {
  const label = TYPE_LABEL[type];
  const same = graph.nodes.filter((n) => n.type === type).length;
  return same === 0 ? label : `${label} ${same + 1}`;
}

export function defaultProps(type: NodeType): NodeProps {
  const out: NodeProps = {};
  for (const field of NODE_PROPERTY_SCHEMA[type]) out[field.key] = field.default;
  return out;
}

export function createNode(
  graph: ScenarioGraph,
  type: NodeType,
  position: { x: number; y: number },
): GraphNode {
  return {
    id: nextNodeId(graph, type),
    type,
    name: nextNodeName(graph, type),
    position: { x: Math.round(position.x), y: Math.round(position.y) },
    props: defaultProps(type),
  };
}

export function createEdge(graph: ScenarioGraph, from: string, to: string): GraphEdge {
  return {
    id: nextEdgeId(graph, from, to),
    from,
    to,
    travelTimeMinutes: 45,
    capacity: 2000,
    cost: 60000,
    available: true,
    temperatureRisk: 0.2,
  };
}

export function nextResourceId(graph: ScenarioGraph, kind: ResourceKind): string {
  const prefix = `res-${kind}-`;
  let n = 1;
  while (graph.resources.some((r) => r.id === `${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}

export function nextShipmentId(graph: ScenarioGraph): string {
  let n = 200;
  while (graph.shipments.some((s) => s.id === `VX-${n}`)) n += 1;
  return `VX-${n}`;
}

/* --------------------------------------------------------------------------- *
 * Serialization — plain JSON, deterministic key order.
 * --------------------------------------------------------------------------- */

export const GRAPH_SCHEMA_VERSION = 1;

export function serializeGraph(graph: ScenarioGraph): string {
  return JSON.stringify(graph, null, 2);
}

export interface ParsedGraph {
  ok: boolean;
  graph?: ScenarioGraph;
  error?: string;
}

export function deserializeGraph(json: string): ParsedGraph {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, error: 'File is not valid JSON.' };
  }
  const g = data as Partial<ScenarioGraph>;
  if (!g || typeof g !== 'object') return { ok: false, error: 'Not a scenario object.' };
  if (g.version !== GRAPH_SCHEMA_VERSION) {
    return { ok: false, error: `Unsupported scenario version ${String(g.version)}.` };
  }
  for (const key of ['nodes', 'edges', 'resources', 'shipments'] as const) {
    if (!Array.isArray(g[key])) return { ok: false, error: `Missing "${key}" array.` };
  }
  // Fill optional arrays / scalars so downstream code never guards for undefined.
  const graph: ScenarioGraph = {
    id: g.id ?? 'imported',
    version: GRAPH_SCHEMA_VERSION,
    name: g.name ?? 'Imported scenario',
    domainModel: g.domainModel ?? 'generic',
    durationMinutes: g.durationMinutes ?? 150,
    timestepMinutes: g.timestepMinutes ?? 5,
    nodes: g.nodes ?? [],
    edges: g.edges ?? [],
    resources: g.resources ?? [],
    shipments: g.shipments ?? [],
    incidents: g.incidents ?? [],
    cascades: g.cascades ?? [],
    constraints: g.constraints ?? [],
    objective: g.objective ?? 'balanced',
  };
  return { ok: true, graph };
}

/**
 * Scenario compiler — the boundary between USER AUTHORING and ENGINE EXECUTION.
 *
 *   ScenarioGraph  ->  validate  ->  compile  ->  engine ScenarioConfig
 *
 * The compiler transforms declarative graph data into the engine's existing
 * abstractions. It contains ZERO simulation: no temperature, no route
 * progression, no viability, no scoring. Those are the engine's job.
 *
 * Two paths:
 *   generic     — synthesises facilities / routes / resources / actions from
 *                 graph structure with domain-agnostic step models.
 *   cold-chain  — reuses the calibrated pharma scenario and overlays the graph
 *                 edits (added nodes/routes/shipments, incidents, constraints,
 *                 objective) so the reference demo is preserved exactly.
 */

import type {
  ActionDefinition,
  CascadeRule,
  ConstraintDefinition,
  Facility,
  MetricDefinition,
  ObjectiveDefinition,
  ResourceDefinition,
  Route,
  ScenarioConfig,
  ScheduledEvent,
  EntitySeed,
} from '../domain';
import { createColdChainModels, switchRoute, type TransitionEnv } from '../engine';
import { COLD_CHAIN, makeColdChainScenario } from '../simulation/scenarios/coldChain';
import { createGenericModels } from './genericModels';
import { enumeratePaths, type GraphPath } from './paths';
import { validateGraph } from './validate';
import type {
  GraphConstraint,
  GraphNode,
  ObjectivePreset,
  ScenarioGraph,
} from './graph';

export interface CompileResult {
  ok: boolean;
  scenario?: ScenarioConfig;
  errors: string[];
  /** Structural facts a UI can show (candidate count hint, etc.). */
  info: {
    domainModel: string;
    facilities: number;
    routes: number;
    shipments: number;
    primaryShipmentId: string | null;
    alternatePaths: number;
  };
}

const NOMINAL_MARGIN = 20; // "on time" allowance beyond the fastest path

/* --------------------------------------------------------------------------- *
 * Objective presets -> weights (sum to 1)
 * --------------------------------------------------------------------------- */

const PRESET_WEIGHTS: Record<
  ObjectivePreset,
  { safety: number; risk: number; cost: number; speed: number }
> = {
  'protect-product': { safety: 0.55, risk: 0.2, cost: 0.1, speed: 0.15 },
  balanced: { safety: 0.4, risk: 0.15, cost: 0.2, speed: 0.25 },
  'minimize-cost': { safety: 0.15, risk: 0.1, cost: 0.5, speed: 0.25 },
  'maximize-service': { safety: 0.25, risk: 0.15, cost: 0.15, speed: 0.45 },
};

/* --------------------------------------------------------------------------- *
 * Entry point
 * --------------------------------------------------------------------------- */

export function compileScenarioGraph(graph: ScenarioGraph): CompileResult {
  const validation = validateGraph(graph);
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.issues.filter((i) => i.severity === 'error').map((i) => i.message),
      info: emptyInfo(graph),
    };
  }

  try {
    const scenario =
      graph.domainModel === 'cold-chain' ? compileColdChain(graph) : compileGeneric(graph);
    return { ok: true, scenario, errors: [], info: infoFor(graph, scenario) };
  } catch (e) {
    return {
      ok: false,
      errors: [e instanceof Error ? e.message : 'Compilation failed.'],
      info: emptyInfo(graph),
    };
  }
}

function emptyInfo(graph: ScenarioGraph): CompileResult['info'] {
  return {
    domainModel: graph.domainModel,
    facilities: graph.nodes.length,
    routes: graph.edges.length,
    shipments: graph.shipments.length,
    primaryShipmentId: null,
    alternatePaths: 0,
  };
}

function infoFor(graph: ScenarioGraph, scenario: ScenarioConfig): CompileResult['info'] {
  const primary = pickPrimaryShipment(graph);
  const alts = primary
    ? Math.max(0, enumeratePaths(graph, primary.originId, primary.destinationId).length - 1)
    : 0;
  return {
    domainModel: graph.domainModel,
    facilities: scenario.facilities.length,
    routes: scenario.routes.length,
    shipments: graph.shipments.length,
    primaryShipmentId: primary?.id ?? null,
    alternatePaths: alts,
  };
}

/** The shipment the decision revolves around: highest priority, then earliest deadline. */
function pickPrimaryShipment(graph: ScenarioGraph) {
  const order: Record<string, number> = { critical: 0, high: 1, normal: 2 };
  return [...graph.shipments].sort(
    (a, b) => order[a.priority] - order[b.priority] || a.deadlineMinutes - b.deadlineMinutes,
  )[0];
}

/* --------------------------------------------------------------------------- *
 * Shared: facilities + resources from graph
 * --------------------------------------------------------------------------- */

function facilityKind(node: GraphNode): Facility['kind'] {
  if (node.type === 'hospital' || node.type === 'destination') return 'destination';
  if (node.type === 'cold-storage' || node.type === 'warehouse') return 'storage';
  return 'hub';
}

function compileFacilities(graph: ScenarioGraph): Facility[] {
  return graph.nodes.map((node) => {
    const capacity =
      typeof node.props.capacity === 'number'
        ? {
            capacity: node.props.capacity,
            used: typeof node.props.occupied === 'number' ? node.props.occupied : 0,
            unit: 'units',
          }
        : undefined;
    return {
      id: node.id,
      kind: facilityKind(node),
      label: node.name,
      position: { ...node.position },
      capacity,
    };
  });
}

function compileResources(graph: ScenarioGraph): ResourceDefinition[] {
  const defs: ResourceDefinition[] = graph.resources.map((r) => {
    if (r.kind === 'budget') {
      return {
        id: r.id,
        label: r.label,
        kind: 'consumable',
        initial: r.quantity,
        capacity: r.quantity,
        unitCost: r.unitCost || 100000,
        unit: '₹L',
        detailFormat: 'currency-lakh',
      };
    }
    if (r.kind === 'storage') {
      return {
        id: r.id,
        label: r.label,
        kind: 'consumable',
        initial: r.available ? r.quantity : 0,
        capacity: r.quantity,
        unit: 'units',
        detailFormat: 'count',
      };
    }
    return {
      id: r.id,
      label: r.label,
      kind: 'discrete',
      initial: r.available ? Math.max(0, Math.round(r.quantity)) : 0,
      detailFormat: 'count',
    };
  });
  // Every scenario needs a budget line so cost-bearing actions can be checked.
  if (!defs.some((d) => d.id === 'res-budget')) {
    defs.push({
      id: 'res-budget',
      label: 'Recovery Budget',
      kind: 'consumable',
      initial: 8,
      capacity: 8,
      unitCost: 100000,
      unit: '₹L',
      detailFormat: 'currency-lakh',
    });
  }
  return defs;
}

/* --------------------------------------------------------------------------- *
 * Shared: incidents + time-triggered cascades -> scheduled events
 * --------------------------------------------------------------------------- */

function compileScheduledEvents(
  graph: ScenarioGraph,
  primaryShipmentEntityId: string,
  resolveBlockedRoutes: (edgeId: string) => string[] = (id) => [id],
): ScheduledEvent[] {
  const events: ScheduledEvent[] = [];

  for (const inc of graph.incidents) {
    if (inc.type === 'refrigeration-failure') {
      const target = inc.targetId ?? primaryShipmentEntityId;
      events.push({
        id: `event-incident-${inc.id}`,
        atMinutes: inc.atMinutes,
        type: 'FAILURE',
        eventClass: 'system',
        entityId: target,
        focusEntityId: target,
        message: 'Refrigeration failure — temperature control lost on the shipment',
        severity: 'critical',
        breaksRefrigeration: [target],
        setFlags: { 'failure:occurred': inc.atMinutes },
      });
    } else if (inc.type === 'route-blockage' && inc.targetId) {
      const blocked = resolveBlockedRoutes(inc.targetId);
      events.push({
        id: `event-incident-${inc.id}`,
        atMinutes: inc.atMinutes,
        type: 'CONSTRAINT_VIOLATED',
        eventClass: 'system',
        routeId: blocked[0] ?? inc.targetId,
        message: 'Route blockage — this corridor is impassable; anything on it is held',
        severity: 'critical',
        blocksRoutes: blocked,
        setFlags: { 'blockage:occurred': inc.atMinutes },
      });
    }
    // resource-unavailable / storage-reduction are applied to the initial state
    // (see `applyResourceIncidents`) — the engine has no mid-run resource-loss.
  }

  // Cascades with a plain time trigger and no gating conditions compile directly
  // to a scheduled event (cheapest path, preserves existing calibration).
  // Everything else — event / metric triggers, or a time trigger with
  // conditions — compiles to a CascadeRule handled inside the step loop.
  for (const c of graph.cascades) {
    if (c.when.kind === 'time' && c.conditions.length === 0) {
      events.push({
        id: `event-cascade-${c.id}`,
        atMinutes: c.when.atMinutes + c.delayMinutes,
        type: c.emit.type,
        eventClass: 'system',
        message: c.emit.message,
        severity: c.emit.severity,
        blocksRoutes: c.emit.blocksRoutes,
        setFlags: c.emit.setFlags,
      });
    }
  }

  return events.sort((a, b) => a.atMinutes - b.atMinutes || a.id.localeCompare(b.id));
}

/**
 * Cascades that need the simulation loop: metric- and event-triggered rules, and
 * time-triggered rules with gating conditions. Each becomes one engine
 * `CascadeRule` with real state effects + a provenance-carrying event.
 * `conditions` that reference a resource's availability are folded onto the
 * trigger as a `whenFlag` / secondary check where the engine supports it;
 * metric conditions are left to the trigger itself.
 */
function compileCascadeRules(graph: ScenarioGraph): CascadeRule[] {
  const rules: CascadeRule[] = [];
  for (const c of graph.cascades) {
    const isLoopRule =
      c.when.kind === 'metric' ||
      c.when.kind === 'event' ||
      (c.when.kind === 'time' && c.conditions.length > 0);
    if (!isLoopRule) continue;

    const trigger: CascadeRule['trigger'] =
      c.when.kind === 'metric'
        ? {
            kind: 'metric',
            metric: c.when.metric,
            operator: c.when.op,
            threshold: c.when.value,
          }
        : c.when.kind === 'event'
          ? { kind: 'event', eventType: c.when.eventType }
          : { kind: 'time', atMinutes: c.when.atMinutes };

    rules.push({
      id: `cascade-${c.id}`,
      label: c.emit.message.length > 48 ? `${c.emit.message.slice(0, 45)}…` : c.emit.message,
      trigger,
      delayMinutes: c.delayMinutes,
      once: c.once,
      effect:
        c.emit.blocksRoutes || c.emit.setFlags
          ? { blocksRoutes: c.emit.blocksRoutes, setFlags: c.emit.setFlags }
          : undefined,
      emit: {
        type: c.emit.type,
        eventClass: 'system',
        message: c.emit.message,
        severity: c.emit.severity,
      },
      sourceId: c.when.kind === 'metric' ? c.when.metric : undefined,
    });
  }
  return rules;
}

function applyResourceIncidents(graph: ScenarioGraph, resources: ResourceDefinition[]): void {
  for (const inc of graph.incidents) {
    if (inc.type === 'resource-unavailable' && inc.targetId) {
      const r = resources.find((x) => x.id === inc.targetId);
      if (r) r.initial = 0;
    }
    if (inc.type === 'storage-reduction' && inc.targetId) {
      const r = resources.find((x) => x.id === inc.targetId);
      if (r && typeof r.initial === 'number') r.initial = Math.round(r.initial * 0.15);
    }
  }
}

/* --------------------------------------------------------------------------- *
 * Shared: user constraints
 * --------------------------------------------------------------------------- */

function compileUserConstraints(graph: ScenarioGraph): ConstraintDefinition[] {
  return graph.constraints.map((c: GraphConstraint) => ({
    id: `constraint-user-${c.id}`,
    type: c.metric,
    label: `${cap(c.metric)} ${c.operator} ${c.value}`,
    severity: c.severity,
    scope: c.scope,
    operator: c.operator,
    value: c.value,
    appliesTo: c.metric,
  }));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* --------------------------------------------------------------------------- *
 * GENERIC compilation
 * --------------------------------------------------------------------------- */

const GENERIC_METRICS: MetricDefinition[] = [
  {
    id: 'serviceCoverage',
    label: 'Service coverage',
    direction: 'maximize',
    aggregation: 'final',
    normalize: { min: 0, max: 1 },
    unit: '%',
    epsilon: 0.01,
  },
  {
    id: 'delay',
    label: 'Delivery delay',
    direction: 'minimize',
    aggregation: 'final',
    normalize: { min: 0, max: 120 },
    unit: 'min',
    epsilon: 0.5,
  },
  {
    id: 'cost',
    label: 'Operating cost',
    direction: 'minimize',
    aggregation: 'final',
    normalize: { min: 0, max: 800000 },
    unit: '₹',
    epsilon: 1,
  },
  {
    id: 'risk',
    label: 'Operational risk',
    direction: 'minimize',
    aggregation: 'max',
    normalize: { min: 0, max: 4 },
    epsilon: 0.01,
  },
];

function genericObjectives(preset: ObjectivePreset): ObjectiveDefinition[] {
  const w = PRESET_WEIGHTS[preset];
  return [
    { id: 'obj-service', label: 'Service', metricId: 'serviceCoverage', weight: w.safety },
    { id: 'obj-risk', label: 'Risk', metricId: 'risk', weight: w.risk },
    { id: 'obj-cost', label: 'Cost', metricId: 'cost', weight: w.cost },
    { id: 'obj-speed', label: 'Speed', metricId: 'delay', weight: w.speed },
  ];
}

interface CompiledPath {
  index: number;
  label: string;
  routeIds: string[];
  cost: number;
  travelTimeMinutes: number;
}

/** Turn a graph path into a chain of dedicated Route objects for one shipment. */
function materialisePath(
  graph: ScenarioGraph,
  shipmentId: string,
  path: GraphPath,
  index: number,
): { routes: Route[]; compiled: CompiledPath } {
  const routes: Route[] = [];
  const routeIds: string[] = [];
  for (let i = 0; i < path.edges.length; i += 1) {
    const edge = graph.edges.find((e) => e.id === path.edges[i])!;
    const rid = `${edge.id}@${shipmentId}-p${index}`;
    routeIds.push(rid);
    routes.push({
      id: rid,
      from: edge.from,
      to: edge.to,
      kind: index === 0 ? 'primary' : 'reroute',
      travelTimeMinutes: edge.travelTimeMinutes,
      blocked: !edge.available,
    });
  }
  for (let i = 0; i < routes.length - 1; i += 1) routes[i].continuesTo = routeIds[i + 1];
  const destName =
    graph.nodes.find((n) => n.id === path.nodes[path.nodes.length - 1])?.name ?? 'destination';
  const viaNames = path.nodes
    .slice(1, -1)
    .map((n) => graph.nodes.find((x) => x.id === n)?.name ?? n);
  return {
    routes,
    compiled: {
      index,
      label: viaNames.length ? `via ${viaNames.join(' → ')}` : `direct to ${destName}`,
      routeIds,
      cost: path.cost,
      travelTimeMinutes: path.travelTimeMinutes,
    },
  };
}

/**
 * The structural half of compilation — facilities, routes, resources, shipment
 * entities and the candidate actions — derived ENTIRELY from the graph. Both the
 * generic and the graph-authored cold-chain paths share this; they differ only
 * in metrics, step models, objectives and physics constants. Nothing from a
 * built-in template scenario ever enters here.
 */
interface CompiledStructure {
  facilities: Facility[];
  routes: Route[];
  resources: ResourceDefinition[];
  entities: EntitySeed[];
  allocations: Record<string, number>;
  actions: ActionDefinition[];
  totalDemand: number;
  nominalDeliveryMinutes: number;
  scheduledEvents: ScheduledEvent[];
  cascadeRules: ReturnType<typeof compileCascadeRules>;
}

function compileStructure(graph: ScenarioGraph, refrigerated: boolean): CompiledStructure {
  const facilities = compileFacilities(graph);
  const resources = compileResources(graph);
  applyResourceIncidents(graph, resources);

  const primary = pickPrimaryShipment(graph);
  const routes: Route[] = [];
  const entities: EntitySeed[] = [];
  const allocations: Record<string, number> = {};
  const pathsByShipment: Record<string, CompiledPath[]> = {};
  const shipmentEntities: ShipmentEntity[] = [];

  graph.shipments.forEach((s, sIdx) => {
    const graphPaths = enumeratePaths(graph, s.originId, s.destinationId);
    const compiledPaths: CompiledPath[] = [];
    graphPaths.forEach((gp, pIdx) => {
      const { routes: r, compiled } = materialisePath(graph, s.id, gp, pIdx);
      routes.push(...r);
      compiledPaths.push(compiled);
    });
    pathsByShipment[s.id] = compiledPaths;

    const entityId = sIdx === 0 ? 'truck-01' : `truck-0${sIdx + 1}`;
    shipmentEntities.push({
      shipmentId: s.id,
      entityId,
      label: s.label,
      priority: s.priority,
      quantity: s.quantity,
      destinationId: s.destinationId,
      paths: compiledPaths,
    });
    entities.push({
      id: entityId,
      kind: 'shipment_vehicle',
      label: s.label,
      routeId: compiledPaths[0]?.routeIds[0] ?? null,
      progress: 0,
      status: 'en_route',
      active: true,
      payload: { [s.destinationId]: s.quantity },
      refrigerated: refrigerated && s.refrigerated,
      coolingEfficiency: 1,
    });
    allocations[s.destinationId] = (allocations[s.destinationId] ?? 0) + s.quantity;
  });

  const totalDemand = Object.values(allocations).reduce((a, b) => a + b, 0);
  const fastest = Math.min(
    ...Object.values(pathsByShipment).flatMap((ps) => ps.map((p) => p.travelTimeMinutes)),
    graph.durationMinutes,
  );
  const nominalDeliveryMinutes = Math.round(fastest + NOMINAL_MARGIN);

  const env: TransitionEnv = { routes, facilities };
  const primaryPaths = primary ? pathsByShipment[primary.id] ?? [] : [];
  const emergencyResource = graph.resources.find(
    (r) => r.kind === 'emergency-vehicle' && r.available && r.quantity >= 1,
  );
  const blockedEdgeIds = new Set(
    graph.incidents
      .filter((i) => i.type === 'route-blockage' && i.targetId)
      .map((i) => i.targetId as string),
  );

  const actions = buildGenericActions(
    'truck-01',
    primaryPaths,
    emergencyResource?.id ?? null,
    Boolean(primary?.refrigerated) && refrigerated,
    env,
    shipmentEntities,
    blockedEdgeIds,
  );

  const scheduledEvents = compileScheduledEvents(graph, 'truck-01', (edgeId) => {
    const ids = routes
      .filter((r) => r.id === edgeId || r.id.startsWith(`${edgeId}@`))
      .map((r) => r.id);
    return ids.length ? ids : [edgeId];
  });

  return {
    facilities,
    routes,
    resources,
    entities,
    allocations,
    actions,
    totalDemand,
    nominalDeliveryMinutes,
    scheduledEvents,
    cascadeRules: compileCascadeRules(graph),
  };
}

function compileGeneric(graph: ScenarioGraph): ScenarioConfig {
  const s = compileStructure(graph, false);

  const constraints: ConstraintDefinition[] = [
    {
      id: 'constraint-final-coverage',
      type: 'service',
      label: 'Full delivery on completion',
      severity: 'hard',
      scope: 'final',
      operator: '>=',
      value: 0.999,
      appliesTo: 'serviceCoverage',
    },
    ...compileUserConstraints(graph),
  ];

  return {
    id: graph.id,
    version: graph.version,
    title: graph.name,
    facilities: s.facilities,
    routes: s.routes,
    metricThresholds: { delay: { min: 0, max: 120 } },
    metricUnits: { delay: 'min', cost: '₹', serviceCoverage: '%' },
    metrics: GENERIC_METRICS,
    resources: s.resources,
    constraints,
    objectives: genericObjectives(graph.objective),
    actions: s.actions,
    initialState: {
      initialCargoTemperature: 0,
      shipmentAllocations: s.allocations,
      entities: s.entities,
    },
    scheduledEvents: s.scheduledEvents,
    cascadeRules: s.cascadeRules,
    stepModels: createGenericModels({
      nominalDeliveryMinutes: s.nominalDeliveryMinutes,
      totalDemandDoses: s.totalDemand,
    }),
    simulation: {
      timestepMinutes: graph.timestepMinutes,
      durationMinutes: graph.durationMinutes,
    },
  };
}

/**
 * A cold-chain scenario the user AUTHORED (not the calibrated pharma template):
 * the graph defines every node, route, resource, shipment and incident. Only the
 * cold-chain PHYSICS — temperature / exposure / viability step models and the
 * hard temperature / viability constraints — is layered on. No template entity
 * leaks in.
 */
function compileColdChainGraph(graph: ScenarioGraph): ScenarioConfig {
  const s = compileStructure(graph, true);

  const metrics: MetricDefinition[] = [
    {
      id: 'temperature',
      label: 'Temperature',
      direction: 'minimize',
      aggregation: 'max',
      normalize: { min: COLD_CHAIN.baselineTemperature, max: COLD_CHAIN.ambientTemperature },
      unit: '°C',
      epsilon: 0.05,
    },
    {
      id: 'viability',
      label: 'Viability',
      direction: 'maximize',
      aggregation: 'min',
      normalize: { min: 0, max: 100 },
      unit: '%',
      epsilon: 0.1,
    },
    {
      id: 'exposure',
      label: 'Thermal exposure',
      direction: 'minimize',
      aggregation: 'cumulative',
      normalize: { min: 0, max: 400 },
      unit: '°C·min',
      epsilon: 0.5,
    },
    ...GENERIC_METRICS,
  ];

  const w = PRESET_WEIGHTS[graph.objective];
  const objectives: ObjectiveDefinition[] = [
    { id: 'obj-safety', label: 'Safety', metricId: 'viability', weight: w.safety },
    { id: 'obj-risk', label: 'Risk', metricId: 'risk', weight: w.risk },
    { id: 'obj-cost', label: 'Cost', metricId: 'cost', weight: w.cost },
    { id: 'obj-speed', label: 'Speed', metricId: 'delay', weight: w.speed },
  ];

  const constraints: ConstraintDefinition[] = [
    {
      id: 'constraint-critical-temperature',
      type: 'temperature',
      label: 'Critical temperature limit',
      severity: 'hard',
      scope: 'trajectory',
      operator: '<=',
      value: COLD_CHAIN.criticalTemperature,
      appliesTo: 'temperature',
    },
    {
      id: 'constraint-min-viability',
      type: 'viability',
      label: 'Minimum usable viability',
      severity: 'hard',
      scope: 'trajectory',
      operator: '>=',
      value: 30,
      appliesTo: 'viability',
    },
    {
      id: 'constraint-final-coverage',
      type: 'service',
      label: 'Full delivery on completion',
      severity: 'hard',
      scope: 'final',
      operator: '>=',
      value: 0.999,
      appliesTo: 'serviceCoverage',
    },
    ...compileUserConstraints(graph),
  ];

  return {
    id: graph.id,
    version: graph.version,
    title: graph.name,
    facilities: s.facilities,
    routes: s.routes,
    metricThresholds: {
      temperature: {
        safe: COLD_CHAIN.safeTemperature,
        critical: COLD_CHAIN.criticalTemperature,
        min: 2,
        max: COLD_CHAIN.ambientTemperature,
      },
      viability: { safe: 70, critical: 50, min: 0, max: 100 },
    },
    metricUnits: { temperature: '°C', viability: '%', delay: 'min', cost: '₹', exposure: '°C·min' },
    metrics,
    resources: s.resources,
    constraints,
    objectives,
    actions: s.actions,
    initialState: {
      initialCargoTemperature: COLD_CHAIN.baselineTemperature,
      shipmentAllocations: s.allocations,
      entities: s.entities,
    },
    scheduledEvents: s.scheduledEvents,
    cascadeRules: s.cascadeRules,
    stepModels: createColdChainModels({
      baselineTemperature: COLD_CHAIN.baselineTemperature,
      ambientTemperature: COLD_CHAIN.ambientTemperature,
      safeTemperature: COLD_CHAIN.safeTemperature,
      failureRatePerMin: COLD_CHAIN.failureRatePerMin,
      recoveryRatePerMin: COLD_CHAIN.recoveryRatePerMin,
      degradationRate: COLD_CHAIN.degradationRate,
      nominalDeliveryMinutes: s.nominalDeliveryMinutes,
      totalDemandDoses: s.totalDemand,
      riskBands: { low: 85, moderate: 70, high: 50 },
    }),
    simulation: {
      timestepMinutes: graph.timestepMinutes,
      durationMinutes: graph.durationMinutes,
    },
  };
}


const DECISION_MINUTE = 20;

interface ShipmentEntity {
  shipmentId: string;
  entityId: string;
  label: string;
  priority: 'critical' | 'high' | 'normal';
  quantity: number;
  destinationId: string;
  paths: CompiledPath[];
}

/** Base edge id from a materialised route id (`<edge>@<ship>-p<idx>` -> `<edge>`). */
function baseEdgeOf(routeId: string): string {
  const at = routeId.indexOf('@');
  return at === -1 ? routeId : routeId.slice(0, at);
}

/**
 * One emergency-vehicle allocation action per shipment: `emergency_<entityId>`.
 * Each requires the single shared emergency-vehicle resource, so the engine can
 * only ever pick one — resource exclusivity by construction. The `apply` handler
 * rescues exactly its target shipment (clear-alternate reroute + expedite);
 * every other shipment is left to the baseline. Which allocation wins is decided
 * by the engine's scoring over serviceCoverage / delay / risk — never here.
 */
function buildEmergencyAllocations(
  emergencyResourceId: string,
  shipments: ShipmentEntity[],
  blockedEdgeIds: Set<string>,
  env: TransitionEnv,
): ActionDefinition[] {
  const decision = DECISION_MINUTE;
  const interceptMinutes = 12;

  return shipments
    .filter((s) => s.paths.length > 0)
    .map((s) => {
      const clearAlt =
        s.paths.find(
          (p) => p.index > 0 && p.routeIds.every((r) => !blockedEdgeIds.has(baseEdgeOf(r))),
        ) ??
        s.paths.find((p) => p.routeIds.every((r) => !blockedEdgeIds.has(baseEdgeOf(r)))) ??
        null;
      const rerouteCost = clearAlt ? Math.round(clearAlt.cost) : 0;

      const action: ActionDefinition = {
        id: `emergency_${s.entityId}`,
        label: `Emergency vehicle → ${s.label}`,
        decisionTimeMinutes: decision,
        preconditions: [
          {
            kind: 'resource',
            ref: emergencyResourceId,
            operator: 'available',
            message: 'Emergency allocation requires an available emergency vehicle.',
          },
        ],
        resourceRequirements: [
          { resourceId: emergencyResourceId, amount: 1 },
          { resourceId: 'res-budget', amount: 2.6 },
        ],
        transitions: [
          { target: 'resource', id: 'res-budget', op: 'allocate', value: 2.6 },
          { target: 'resource', id: emergencyResourceId, op: 'allocate', value: 1 },
        ],
        apply: (state, ctx) => {
          const ent = state.entities[s.entityId];
          if (!ent) return;
          if (ctx.sinceDecision < interceptMinutes) return;
          if (state.flags['emergency:done']) {
            if (ent.progress < 1 && ent.active) {
              ent.progress = Math.min(1, ent.progress + 0.05);
            }
            return;
          }
          state.flags['emergency:done'] = ctx.now;
          state.flags[`emergency:target:${s.entityId}`] = ctx.now;

          const heldOnBlocked =
            ent.routeId != null && state.flags[`route-blocked:${ent.routeId}`] != null;
          if (heldOnBlocked && clearAlt) {
            switchRoute(state, s.entityId, clearAlt.routeIds[0], env);
            ent.progress = 0;
            state.flags['spend:res-budget'] =
              (Number(state.flags['spend:res-budget']) || 0) + rerouteCost;
            const b = state.resources['res-budget'];
            if (b) b.quantity = Math.max(0, b.quantity - rerouteCost / 100000);
          }
          ent.refrigerated = true;
          ent.coolingEfficiency = 1;
          ent.status = 'recovering';

          ctx.emit({
            id: 'interception',
            type: 'INTERCEPTION',
            eventClass: 'system',
            entityId: s.entityId,
            message:
              heldOnBlocked && clearAlt
                ? `Emergency vehicle diverts ${s.label} onto a clear corridor`
                : `Emergency vehicle takes over ${s.label} — expedited`,
            severity: 'info',
            focusEntityId: s.entityId,
          });
          ctx.emit({
            id: 'recovery',
            type: 'RECOVERY',
            eventClass: 'system',
            entityId: s.entityId,
            message: `${s.label} stabilising under emergency escort`,
            severity: 'info',
          });
        },
        emittedEvents: [
          {
            id: 'dispatch',
            type: 'VEHICLE_DISPATCHED',
            eventClass: 'decision',
            atOffsetMinutes: 0,
            entityId: s.entityId,
            message: `Emergency vehicle dispatched to ${s.label}`,
            severity: 'info',
          },
        ],
        costModel: { perResource: { 'res-budget': 100000 } },
      };
      return action;
    });
}

function buildGenericActions(
  primaryEntityId: string,
  primaryPaths: CompiledPath[],
  emergencyResourceId: string | null,
  refrigerated: boolean,
  env: TransitionEnv,
  shipmentEntities: ShipmentEntity[],
  blockedEdgeIds: Set<string>,
): ActionDefinition[] {
  const decision = DECISION_MINUTE;
  const actions: ActionDefinition[] = [
    {
      id: 'continue',
      label: 'Continue Plan',
      decisionTimeMinutes: decision,
      preconditions: [],
      resourceRequirements: [{ resourceId: 'res-budget', amount: 0.2 }],
      transitions: [{ target: 'resource', id: 'res-budget', op: 'allocate', value: 0.2 }],
      emittedEvents: [
        {
          id: 'decision',
          type: 'DECISION',
          eventClass: 'decision',
          atOffsetMinutes: 0,
          entityId: primaryEntityId,
          message: 'Operator holds the current plan',
          severity: 'warning',
        },
      ],
      costModel: { perResource: { 'res-budget': 100000 } },
    },
  ];

  const alternates = primaryPaths.slice(1);
  if (alternates.length > 0) {
    actions.push({
      id: 'reroute',
      label: 'Reroute',
      decisionTimeMinutes: decision,
      preconditions: [],
      resourceRequirements: [{ resourceId: 'res-budget', amount: 1 }],
      parameters: {
        altPathIndex: { type: 'number', values: alternates.map((p) => p.index) },
      },
      transitions: [{ target: 'resource', id: 'res-budget', op: 'allocate', value: 1 }],
      apply: (state, ctx) => {
        if (state.flags['reroute:done']) return;
        const idx = Number(ctx.parameterValues?.altPathIndex ?? alternates[0].index);
        const alt = primaryPaths.find((p) => p.index === idx);
        const ent = state.entities[primaryEntityId];
        if (!alt || !ent) return;
        state.flags['reroute:done'] = ctx.now;
        switchRoute(state, primaryEntityId, alt.routeIds[0], env);
        ent.progress = 0;
        ent.status = 'en_route';
        const rupees = Math.round(alt.cost);
        state.flags['spend:res-budget'] =
          (Number(state.flags['spend:res-budget']) || 0) + rupees;
        const b = state.resources['res-budget'];
        if (b) b.quantity = Math.max(0, b.quantity - rupees / 100000);
        ctx.emit({
          id: 'reroute',
          type: 'REROUTE',
          eventClass: 'decision',
          entityId: primaryEntityId,
          message: `Shipment rerouted ${alt.label}`,
          severity: 'info',
          focusEntityId: primaryEntityId,
        });
      },
      emittedEvents: [],
      costModel: { perResource: { 'res-budget': 100000 } },
    });
  }

  // Multi-shipment contention: one scarce emergency vehicle, several shipments
  // that may need it. Emit an allocation action per shipment and let the engine
  // choose (see buildEmergencyAllocations). Single-shipment scenarios keep the
  // simpler `emergency` action for backward compatibility.
  if (emergencyResourceId && shipmentEntities.length >= 2) {
    actions.push(
      ...buildEmergencyAllocations(emergencyResourceId, shipmentEntities, blockedEdgeIds, env),
    );
  } else if (emergencyResourceId) {
    const interceptMinutes = 14;
    actions.push({
      id: 'emergency',
      label: 'Emergency Response',
      decisionTimeMinutes: decision,
      preconditions: [
        {
          kind: 'resource',
          ref: emergencyResourceId,
          operator: 'available',
          message: 'Emergency response requires an available emergency vehicle.',
        },
      ],
      resourceRequirements: [
        { resourceId: emergencyResourceId, amount: 1 },
        { resourceId: 'res-budget', amount: 2.6 },
      ],
      transitions: [
        { target: 'resource', id: 'res-budget', op: 'allocate', value: 2.6 },
        { target: 'resource', id: emergencyResourceId, op: 'allocate', value: 1 },
      ],
      apply: (state, ctx) => {
        const ent = state.entities[primaryEntityId];
        if (!ent) return;
        if (ctx.sinceDecision < interceptMinutes) return;
        if (state.flags['emergency:done']) {
          // Escort: the dedicated vehicle keeps the shipment moving faster.
          if (ent.progress < 1) ent.progress = Math.min(1, ent.progress + 0.04);
          return;
        }
        state.flags['emergency:done'] = ctx.now;
        if (refrigerated) {
          ent.refrigerated = true;
          ent.coolingEfficiency = 1;
        }
        ent.status = 'recovering';
        ctx.emit({
          id: 'interception',
          type: 'INTERCEPTION',
          eventClass: 'system',
          entityId: primaryEntityId,
          message: refrigerated
            ? 'Emergency vehicle intercepts — cargo cooling restored'
            : 'Emergency vehicle takes over — shipment expedited',
          severity: 'info',
          focusEntityId: primaryEntityId,
        });
        ctx.emit({
          id: 'recovery',
          type: 'RECOVERY',
          eventClass: 'system',
          entityId: primaryEntityId,
          message: 'Shipment stabilising',
          severity: 'info',
        });
      },
      emittedEvents: [
        {
          id: 'dispatch',
          type: 'VEHICLE_DISPATCHED',
          eventClass: 'decision',
          atOffsetMinutes: 0,
          entityId: primaryEntityId,
          message: 'Emergency vehicle dispatched',
          severity: 'info',
        },
      ],
      costModel: { perResource: { 'res-budget': 100000 } },
    });
  }

  return actions;
}

/* --------------------------------------------------------------------------- *
 * COLD-CHAIN compilation
 *
 * Two sub-paths, and the choice is structural, not cosmetic:
 *
 *   PHARMA OVERLAY — the graph IS the calibrated pharma template (every base
 *     facility id is present). The base scenario's calibrated actions
 *     (reroute_storage / emergency_interception / hybrid with their over-capacity
 *     cooling handlers) are preserved and the graph's edits are overlaid.
 *
 *   AUTHORED       — any other cold-chain graph. The GRAPH defines the entire
 *     world; only the cold-chain physics (temperature / exposure / viability
 *     models + hard temperature / viability constraints) is layered on. No
 *     template entity leaks in — see compileColdChainGraph.
 * --------------------------------------------------------------------------- */

/** The facility ids the calibrated pharma scenario is built around. */
const PHARMA_BASE_FACILITY_IDS = [
  'hub',
  'hospital-a',
  'hospital-b',
  'cold-storage',
  'cold-store-b',
  'support-depot',
];

function isPharmaDerived(graph: ScenarioGraph): boolean {
  const ids = new Set(graph.nodes.map((n) => n.id));
  return PHARMA_BASE_FACILITY_IDS.every((id) => ids.has(id));
}

function compileColdChain(graph: ScenarioGraph): ScenarioConfig {
  if (!isPharmaDerived(graph)) return compileColdChainGraph(graph);
  // Incidents that the pharma scenario factory understands natively.
  const failure = graph.incidents.find((i) => i.type === 'refrigeration-failure');
  const blockage = graph.incidents.find((i) => i.type === 'route-blockage');
  const base = makeColdChainScenario({
    refrigerationFailureAtMinutes: failure ? failure.atMinutes : undefined,
    routeBlockage:
      blockage && blockage.targetId
        ? { routeId: blockage.targetId, atMinutes: blockage.atMinutes }
        : undefined,
  });

  // --- overlay: node positions + any node the user added ---
  const facilities: Facility[] = base.facilities.map((f) => {
    const node = graph.nodes.find((n) => n.id === f.id);
    return node ? { ...f, label: node.name, position: { ...node.position } } : f;
  });
  for (const node of graph.nodes) {
    if (!facilities.some((f) => f.id === node.id)) {
      facilities.push({
        id: node.id,
        kind: facilityKind(node),
        label: node.name,
        position: { ...node.position },
        capacity:
          typeof node.props.capacity === 'number'
            ? {
                capacity: node.props.capacity,
                used: typeof node.props.occupied === 'number' ? node.props.occupied : 0,
                unit: 'doses',
              }
            : undefined,
      });
    }
  }

  // --- overlay: user-added routes + edge blocked/time edits ---
  const routes: Route[] = base.routes.map((r) => {
    const edge = graph.edges.find((e) => e.id === r.id);
    if (!edge) return r;
    return { ...r, travelTimeMinutes: edge.travelTimeMinutes, blocked: !edge.available };
  });
  for (const edge of graph.edges) {
    if (!routes.some((r) => r.id === edge.id)) {
      routes.push({
        id: edge.id,
        from: edge.from,
        to: edge.to,
        kind: 'reroute',
        travelTimeMinutes: edge.travelTimeMinutes,
        blocked: !edge.available,
      });
    }
  }

  // --- overlay: extra shipments become extra shipment entities ---
  const entities: EntitySeed[] = [...base.initialState.entities];
  const allocations: Record<string, number> = { ...base.initialState.shipmentAllocations };
  graph.shipments.forEach((s, i) => {
    if (i === 0) return; // the first shipment is the base truck-01
    const paths = enumeratePaths(graph, s.originId, s.destinationId);
    const first = paths[0];
    if (!first) return;
    entities.push({
      id: `truck-0${i + 1}`,
      kind: 'shipment_vehicle',
      label: s.label,
      routeId: first.edges[0] ?? null,
      progress: 0,
      status: 'en_route',
      active: true,
      payload: { [s.destinationId]: s.quantity },
      refrigerated: s.refrigerated,
      coolingEfficiency: 1,
    });
    allocations[s.destinationId] = (allocations[s.destinationId] ?? 0) + s.quantity;
  });

  // --- overlay: objective preset -> weights on the pharma objectives ---
  const w = PRESET_WEIGHTS[graph.objective];
  const objByMetric: Record<string, number> = {
    viability: w.safety,
    risk: w.risk,
    cost: w.cost,
    delay: w.speed,
  };
  const objectives: ObjectiveDefinition[] = base.objectives.map((o) => ({
    ...o,
    weight: objByMetric[String(o.metricId)] ?? o.weight,
  }));

  return {
    ...base,
    id: graph.id,
    title: graph.name,
    facilities,
    routes,
    objectives,
    constraints: [...base.constraints, ...compileUserConstraints(graph)],
    cascadeRules: [...(base.cascadeRules ?? []), ...compileCascadeRules(graph)],
    initialState: { ...base.initialState, entities, shipmentAllocations: allocations },
    simulation: {
      timestepMinutes: graph.timestepMinutes || base.simulation.timestepMinutes,
      durationMinutes: graph.durationMinutes || base.simulation.durationMinutes,
    },
  };
}

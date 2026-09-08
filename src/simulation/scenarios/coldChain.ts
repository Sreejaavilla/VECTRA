/**
 * The reference domain: a refrigerated vaccine shipment, a refrigeration
 * failure in transit, and four ways to respond.
 *
 * Everything domain-specific lives here as CONFIGURATION — thresholds, rates,
 * routes, actions, constraints, objectives. The engine that consumes it knows
 * nothing about vaccines. Swapping this file for an event-operations or
 * workforce-allocation scenario is the whole point of the architecture.
 *
 * The thermal and viability models are a SIMPLIFIED DECISION-SUPPORT MODEL.
 * They are not medically meaningful and are not represented as such anywhere in
 * the UI.
 */

import type {
  ActionDefinition,
  ConstraintDefinition,
  Facility,
  MetricDefinition,
  ObjectiveDefinition,
  ResourceDefinition,
  Route,
  ScenarioConfig,
  SimulationState,
} from '../../domain';
import { createColdChainModels, type ColdChainModelConfig } from '../../engine';
import { switchRoute } from '../../engine';

/* --------------------------------------------------------------------------- *
 * Constants — every number the models use lives here, nowhere else.
 * --------------------------------------------------------------------------- */

export const COLD_CHAIN = {
  baselineTemperature: 5,
  ambientTemperature: 26,
  safeTemperature: 8,
  criticalTemperature: 14,
  /** Exponential approach toward ambient once refrigeration is lost. */
  failureRatePerMin: 0.011,
  /** Exponential approach toward baseline at full cooling efficiency. */
  recoveryRatePerMin: 0.06,
  /** Viability points lost per degree-minute above the safe temperature. */
  degradationRate: 0.35,
  timestepMinutes: 5,
  durationMinutes: 150,
  failureTimeMinutes: 35,
  nominalDeliveryMinutes: 95,
  /**
   * A support vehicle rated for 1,200 doses asked to re-cool 2,100 restores
   * temperature at well under half rate. Splitting the load avoids this.
   */
  supportVehicleCapacityDoses: 1200,
  overCapacityCoolingEfficiency: 0.25,
  doses: { 'hospital-a': 1200, 'hospital-b': 900 },
} as const;

const MODEL_CONFIG: ColdChainModelConfig = {
  baselineTemperature: COLD_CHAIN.baselineTemperature,
  ambientTemperature: COLD_CHAIN.ambientTemperature,
  safeTemperature: COLD_CHAIN.safeTemperature,
  failureRatePerMin: COLD_CHAIN.failureRatePerMin,
  recoveryRatePerMin: COLD_CHAIN.recoveryRatePerMin,
  degradationRate: COLD_CHAIN.degradationRate,
  nominalDeliveryMinutes: COLD_CHAIN.nominalDeliveryMinutes,
  riskBands: { low: 85, moderate: 70, high: 50 },
};

/* --------------------------------------------------------------------------- *
 * Topology
 * --------------------------------------------------------------------------- */

const facilities: Facility[] = [
  { id: 'hub', kind: 'hub', label: 'Distribution Hub', position: { x: 8, y: 30 } },
  {
    id: 'hospital-a',
    kind: 'destination',
    label: 'Hospital A',
    position: { x: 88, y: 12 },
    capacity: { capacity: 1200, used: 0, unit: 'doses' },
    meta: { priority: 'CRITICAL' },
  },
  {
    id: 'hospital-b',
    kind: 'destination',
    label: 'Hospital B',
    position: { x: 88, y: 46 },
    capacity: { capacity: 900, used: 0, unit: 'doses' },
    meta: { priority: 'NORMAL' },
  },
  {
    id: 'cold-storage',
    kind: 'storage',
    label: 'Cold Storage',
    position: { x: 50, y: 54 },
    capacity: { capacity: 5000, used: 2600, unit: 'doses' },
  },
  { id: 'support-depot', kind: 'hub', label: 'Support Depot', position: { x: 34, y: 6 } },
];

/** The point on the primary corridor where an intercept happens. */
const INTERCEPT: { x: number; y: number } = { x: 66, y: 18 };

const routes: Route[] = [
  {
    id: 'route-hub-hospital-a',
    from: 'hub',
    to: 'hospital-a',
    kind: 'primary',
    travelTimeMinutes: 95,
    continuesTo: 'route-hospital-a-hospital-b',
    waypoints: [
      { x: 8, y: 30 },
      { x: 40, y: 22 },
      INTERCEPT,
      { x: 88, y: 12 },
    ],
  },
  {
    id: 'route-hospital-a-hospital-b',
    from: 'hospital-a',
    to: 'hospital-b',
    kind: 'primary',
    travelTimeMinutes: 25,
    waypoints: [
      { x: 88, y: 12 },
      { x: 92, y: 29 },
      { x: 88, y: 46 },
    ],
  },
  {
    id: 'route-hub-storage',
    from: 'hub',
    to: 'cold-storage',
    kind: 'reroute',
    travelTimeMinutes: 70,
    waypoints: [
      { x: 8, y: 30 },
      { x: 40, y: 22 },
      { x: 46, y: 40 },
      { x: 50, y: 54 },
    ],
  },
  {
    id: 'route-storage-hospital-a',
    from: 'cold-storage',
    to: 'hospital-a',
    kind: 'reroute',
    travelTimeMinutes: 45,
    continuesTo: 'route-hospital-a-hospital-b',
    waypoints: [
      { x: 50, y: 54 },
      { x: 68, y: 34 },
      { x: 88, y: 12 },
    ],
  },
  {
    id: 'route-emergency',
    from: 'support-depot',
    to: 'hospital-a',
    kind: 'emergency',
    travelTimeMinutes: 20,
    waypoints: [
      { x: 34, y: 6 },
      { x: 52, y: 14 },
      INTERCEPT,
    ],
  },
  {
    id: 'route-intercept-storage',
    from: 'support-depot',
    to: 'cold-storage',
    kind: 'emergency',
    travelTimeMinutes: 30,
    continuesTo: 'route-storage-hospital-b',
    waypoints: [
      INTERCEPT,
      { x: 58, y: 36 },
      { x: 50, y: 54 },
    ],
  },
  {
    id: 'route-storage-hospital-b',
    from: 'cold-storage',
    to: 'hospital-b',
    kind: 'reroute',
    travelTimeMinutes: 35,
    waypoints: [
      { x: 50, y: 54 },
      { x: 70, y: 52 },
      { x: 88, y: 46 },
    ],
  },
];

/* --------------------------------------------------------------------------- *
 * Metrics — direction and aggregation are declared once, here.
 * --------------------------------------------------------------------------- */

const metrics: MetricDefinition[] = [
  {
    id: 'temperature',
    label: 'Temperature',
    direction: 'minimize',
    // The PEAK is what damages cargo; an average would hide a lethal excursion.
    aggregation: 'max',
    normalize: { min: COLD_CHAIN.baselineTemperature, max: COLD_CHAIN.ambientTemperature },
    unit: '°C',
    epsilon: 0.05,
  },
  {
    id: 'viability',
    label: 'Viability',
    direction: 'maximize',
    // The WORST dip, not the final figure: cargo does not un-spoil.
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
  {
    id: 'cost',
    label: 'Recovery cost',
    direction: 'minimize',
    aggregation: 'final',
    normalize: { min: 0, max: 600000 },
    unit: '₹',
    epsilon: 1,
  },
  {
    id: 'delay',
    label: 'Delivery delay',
    direction: 'minimize',
    aggregation: 'final',
    normalize: { min: 0, max: 90 },
    unit: 'min',
    epsilon: 0.5,
  },
  {
    id: 'risk',
    label: 'Risk band',
    direction: 'minimize',
    aggregation: 'max',
    normalize: { min: 1, max: 4 },
    epsilon: 0.01,
  },
];

/* --------------------------------------------------------------------------- *
 * Resources
 * --------------------------------------------------------------------------- */

const resources: ResourceDefinition[] = [
  {
    id: 'res-support-vehicle',
    label: 'Refrigerated Support Vehicle',
    kind: 'boolean',
    initial: true,
    detailFormat: 'availability',
  },
  {
    id: 'res-cold-storage',
    label: 'Cold Storage',
    kind: 'consumable',
    initial: 2400,
    capacity: 2400,
    unit: 'doses',
    detailFormat: 'count',
  },
  {
    id: 'res-budget',
    label: 'Recovery Budget',
    kind: 'consumable',
    initial: 8,
    capacity: 8,
    // ₹1 lakh per unit, so the cost metric comes out in rupees.
    unitCost: 100000,
    unit: '₹L',
    detailFormat: 'currency-lakh',
  },
];

/* --------------------------------------------------------------------------- *
 * Constraints — note the two scopes.
 * --------------------------------------------------------------------------- */

const constraints: ConstraintDefinition[] = [
  {
    id: 'constraint-vehicle-available',
    type: 'vehicle',
    label: 'Support vehicle availability',
    severity: 'soft',
    scope: 'static',
    operator: 'available',
    value: true,
    appliesTo: 'res-support-vehicle',
  },
  {
    // A hard limit on the trajectory: an excursion past this is unrecoverable,
    // and no amount of later cooling makes the cargo usable again. A strategy
    // can pass every static check and still breach this in flight.
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
    id: 'constraint-safe-temperature',
    type: 'temperature',
    label: 'Safe temperature target',
    severity: 'soft',
    scope: 'trajectory',
    operator: '<=',
    value: COLD_CHAIN.safeTemperature,
    appliesTo: 'temperature',
  },
  {
    id: 'constraint-max-delay',
    type: 'delay',
    label: 'Maximum acceptable delay',
    severity: 'soft',
    scope: 'trajectory',
    operator: '<=',
    value: 90,
    appliesTo: 'delay',
  },
];

/* --------------------------------------------------------------------------- *
 * Objectives — weights sum to 1 (global convention).
 * --------------------------------------------------------------------------- */

const objectives: ObjectiveDefinition[] = [
  { id: 'obj-safety', label: 'Safety', metricId: 'viability', weight: 0.4 },
  { id: 'obj-speed', label: 'Speed', metricId: 'delay', weight: 0.25 },
  { id: 'obj-cost', label: 'Cost', metricId: 'cost', weight: 0.2 },
  { id: 'obj-risk', label: 'Risk', metricId: 'risk', weight: 0.15 },
];

export const OBJECTIVE_IDS = objectives.map((o) => o.id);

/* --------------------------------------------------------------------------- *
 * Action handlers — the domain-rich half of the vocabulary.
 * --------------------------------------------------------------------------- */

const transitionEnv = { routes, facilities };

function totalPayload(entity: SimulationState['entities'][string]): number {
  return Object.keys(entity.payload).reduce((sum, key) => sum + entity.payload[key], 0);
}

/** Reroute-to-storage: hand the cargo into the cold room, then resume delivery. */
const storageTransferHandler: ActionDefinition['apply'] = (state, ctx) => {
  const truck = state.entities['truck-01'];
  if (!truck || state.flags['storage:transferred']) return;
  if (truck.routeId !== 'route-hub-storage' || truck.progress < 1) return;

  state.flags['storage:transferred'] = ctx.now;
  truck.refrigerated = true;
  truck.coolingEfficiency = 1;
  truck.status = 'recovering';

  const facility = state.facilities['cold-storage'];
  if (facility?.capacity) {
    facility.capacity.used = Math.min(
      facility.capacity.capacity,
      facility.capacity.used + totalPayload(truck),
    );
  }

  ctx.emit({
    id: 'storage-transfer',
    type: 'STORAGE_TRANSFER',
    eventClass: 'decision',
    entityId: 'truck-01',
    facilityId: 'cold-storage',
    message: 'Shipment moved into the cold room — temperature control restored',
    severity: 'info',
    focusEntityId: 'truck-01',
  });

  switchRoute(state, 'truck-01', 'route-storage-hospital-a', transitionEnv);
  truck.progress = 0;
  truck.status = 'en_route';
};

/** Emergency interception: one vehicle re-cools the whole load, over capacity. */
const interceptionHandler: ActionDefinition['apply'] = (state, ctx) => {
  const support = state.entities['support-01'];
  const truck = state.entities['truck-01'];
  if (!support || !truck || state.flags['intercept:done']) return;
  if (support.routeId !== 'route-emergency' || support.progress < 1) return;

  state.flags['intercept:done'] = ctx.now;
  truck.refrigerated = true;
  // Rated for 1,200 doses, handed 2,100 — recovery is throttled accordingly.
  truck.coolingEfficiency =
    totalPayload(truck) > COLD_CHAIN.supportVehicleCapacityDoses
      ? COLD_CHAIN.overCapacityCoolingEfficiency
      : 1;
  truck.status = 'recovering';
  support.status = 'escorting';

  ctx.emit({
    id: 'interception',
    type: 'INTERCEPTION',
    eventClass: 'system',
    entityId: 'truck-01',
    message:
      truck.coolingEfficiency < 1
        ? 'Support vehicle intercepts — re-cooling the full load, above its rated capacity'
        : 'Support vehicle intercepts — cargo re-cooled in transit',
    severity: 'info',
    focusEntityId: 'truck-01',
  });
  ctx.emit({
    id: 'recovery',
    type: 'RECOVERY',
    eventClass: 'system',
    entityId: 'truck-01',
    message: 'Cargo temperature trending back toward the safe range',
    severity: 'info',
    focusEntityId: 'truck-01',
  });
};

/**
 * Hybrid: partition the shipment at the intercept point.
 *
 *   shipment
 *     ├── Hospital A (critical) -> stays on the truck, re-cooled at full rate
 *     └── Hospital B (normal)   -> transferred to the support vehicle,
 *                                  routed via cold storage
 *
 * This is the case a declarative `target + op + value` transition would only
 * express awkwardly, which is exactly why the handler escape hatch exists.
 */
const hybridHandler: ActionDefinition['apply'] = (state, ctx) => {
  const support = state.entities['support-01'];
  const truck = state.entities['truck-01'];
  if (!support || !truck) return;

  if (!state.flags['hybrid:split']) {
    if (support.routeId !== 'route-emergency' || support.progress < 1) return;

    state.flags['hybrid:split'] = ctx.now;

    const handover = truck.payload['hospital-b'] ?? 0;
    if (handover > 0) {
      delete truck.payload['hospital-b'];
      support.payload['hospital-b'] = handover;
      // The doses carry their accumulated damage with them.
      support.cargoExposure = truck.cargoExposure;
      support.cargoTemperature = truck.cargoTemperature;
    }

    truck.refrigerated = true;
    truck.coolingEfficiency = 1;
    truck.status = 'recovering';
    support.refrigerated = true;
    support.coolingEfficiency = 1;
    support.status = 'transferring';

    ctx.emit({
      id: 'split',
      type: 'INTERCEPTION',
      eventClass: 'decision',
      entityId: 'truck-01',
      message: `Shipment partitioned — ${handover.toLocaleString()} Hospital B doses moved to the support vehicle, both loads now within cooling capacity`,
      severity: 'info',
      focusEntityId: 'truck-01',
    });

    switchRoute(state, 'support-01', 'route-intercept-storage', transitionEnv);
    support.progress = 0;
    return;
  }

  if (
    !state.flags['hybrid:stored'] &&
    support.routeId === 'route-storage-hospital-b'
  ) {
    state.flags['hybrid:stored'] = ctx.now;
    ctx.emit({
      id: 'storage-stop',
      type: 'STORAGE_TRANSFER',
      eventClass: 'system',
      entityId: 'support-01',
      facilityId: 'cold-storage',
      message: 'Hospital B doses stabilised in cold storage, then released for delivery',
      severity: 'info',
      focusEntityId: 'support-01',
    });
  }
};

/* --------------------------------------------------------------------------- *
 * Actions
 * --------------------------------------------------------------------------- */

const actions: ActionDefinition[] = [
  {
    id: 'continue',
    label: 'Continue Delivery',
    decisionTimeMinutes: 40,
    preconditions: [],
    resourceRequirements: [{ resourceId: 'res-budget', amount: 0.4 }],
    transitions: [
      { target: 'resource', id: 'res-budget', op: 'allocate', value: 0.4 },
      { target: 'entity', id: 'truck-01', op: 'set-status', value: 'refrigeration_failed' },
    ],
    emittedEvents: [
      {
        id: 'decision',
        type: 'DECISION',
        eventClass: 'decision',
        atOffsetMinutes: 0,
        entityId: 'truck-01',
        message: 'Operator elects to continue delivery on the primary route',
        severity: 'warning',
        focusEntityId: 'truck-01',
      },
    ],
    costModel: { fixed: 0, perResource: { 'res-budget': 100000 } },
  },
  {
    id: 'reroute_storage',
    label: 'Reroute to Cold Storage',
    decisionTimeMinutes: 42,
    preconditions: [],
    resourceRequirements: [
      { resourceId: 'res-cold-storage', amount: 2100 },
      { resourceId: 'res-budget', amount: 1.2 },
    ],
    transitions: [
      { target: 'resource', id: 'res-budget', op: 'allocate', value: 1.2 },
      { target: 'resource', id: 'res-cold-storage', op: 'allocate', value: 2100 },
      {
        target: 'entity',
        id: 'truck-01',
        op: 'route-switch',
        value: 'route-hub-storage',
      },
    ],
    apply: storageTransferHandler,
    emittedEvents: [
      {
        id: 'decision',
        type: 'REROUTE',
        eventClass: 'decision',
        atOffsetMinutes: 0,
        entityId: 'truck-01',
        routeId: 'route-hub-storage',
        message: 'Shipment rerouted toward the cold-storage corridor',
        severity: 'info',
        focusEntityId: 'truck-01',
      },
      {
        id: 'storage-allocated',
        type: 'RESOURCE_ALLOCATED',
        eventClass: 'decision',
        atOffsetMinutes: 0.5,
        resourceId: 'res-cold-storage',
        message: 'Cold-storage capacity reserved for 2,100 doses',
        severity: 'info',
      },
    ],
    costModel: { fixed: 0, perResource: { 'res-budget': 100000 } },
  },
  {
    id: 'emergency_interception',
    label: 'Emergency Interception',
    decisionTimeMinutes: 40,
    parameters: {
      decisionTimeMinutes: {
        type: 'number',
        values: [36, 38, 40, 42, 44],
      },
    },
    preconditions: [
      {
        kind: 'resource',
        ref: 'res-support-vehicle',
        operator: 'available',
        message:
          'Emergency interception requires a refrigerated support vehicle, and none is available',
      },
    ],
    resourceRequirements: [
      { resourceId: 'res-support-vehicle', amount: true },
      { resourceId: 'res-budget', amount: 2.6 },
    ],
    transitions: [
      { target: 'resource', id: 'res-budget', op: 'allocate', value: 2.6 },
      { target: 'resource', id: 'res-support-vehicle', op: 'allocate', value: 1 },
      { target: 'entity', id: 'support-01', op: 'set-active', value: true },
      { target: 'entity', id: 'support-01', op: 'set-status', value: 'dispatched' },
      {
        target: 'entity',
        id: 'support-01',
        op: 'route-switch',
        value: 'route-emergency',
      },
    ],
    apply: interceptionHandler,
    emittedEvents: [
      {
        id: 'decision',
        type: 'VEHICLE_DISPATCHED',
        eventClass: 'decision',
        atOffsetMinutes: 0,
        entityId: 'support-01',
        message: 'Refrigerated support vehicle dispatched from the Support Depot',
        severity: 'info',
        focusEntityId: 'support-01',
      },
      {
        id: 'resource-allocated',
        type: 'RESOURCE_ALLOCATED',
        eventClass: 'decision',
        atOffsetMinutes: 0.5,
        resourceId: 'res-support-vehicle',
        message: 'Support vehicle and ₹2.6L of recovery budget allocated',
        severity: 'info',
      },
    ],
    costModel: { fixed: 0, perResource: { 'res-budget': 100000 } },
  },
  {
    id: 'hybrid',
    label: 'Hybrid Recovery',
    // Same moment as emergency interception — the operator decides at the same
    // time, just differently. Holding the decision time equal is what makes the
    // comparison between the two a comparison of the DECISION, not of latency.
    decisionTimeMinutes: 40,
    parameters: {
      decisionTimeMinutes: {
        type: 'number',
        values: [36, 38, 40, 42, 44],
      },
    },
    preconditions: [
      {
        kind: 'resource',
        ref: 'res-support-vehicle',
        operator: 'available',
        message: 'Hybrid recovery requires a refrigerated support vehicle to take the split load',
      },
    ],
    resourceRequirements: [
      { resourceId: 'res-support-vehicle', amount: true },
      { resourceId: 'res-cold-storage', amount: 900 },
      { resourceId: 'res-budget', amount: 3.4 },
    ],
    transitions: [
      { target: 'resource', id: 'res-budget', op: 'allocate', value: 3.4 },
      { target: 'resource', id: 'res-support-vehicle', op: 'allocate', value: 1 },
      { target: 'resource', id: 'res-cold-storage', op: 'allocate', value: 900 },
      { target: 'entity', id: 'support-01', op: 'set-active', value: true },
      { target: 'entity', id: 'support-01', op: 'set-status', value: 'dispatched' },
      {
        target: 'entity',
        id: 'support-01',
        op: 'route-switch',
        value: 'route-emergency',
      },
    ],
    apply: hybridHandler,
    emittedEvents: [
      {
        id: 'decision',
        type: 'VEHICLE_DISPATCHED',
        eventClass: 'decision',
        atOffsetMinutes: 0,
        entityId: 'support-01',
        message:
          'Support vehicle dispatched to partition the shipment — critical doses stay on the primary route',
        severity: 'info',
        focusEntityId: 'support-01',
      },
      {
        id: 'resource-allocated',
        type: 'RESOURCE_ALLOCATED',
        eventClass: 'decision',
        atOffsetMinutes: 0.5,
        resourceId: 'res-budget',
        message: 'Support vehicle, 900 doses of cold storage and ₹3.4L allocated',
        severity: 'info',
      },
    ],
    costModel: { fixed: 0, perResource: { 'res-budget': 100000 } },
  },
];

/* --------------------------------------------------------------------------- *
 * Scenario
 * --------------------------------------------------------------------------- */

export const coldChainScenario: ScenarioConfig = {
  id: 'cold-chain-recovery',
  version: 2,
  title: 'Cold-Chain Vaccine Recovery',
  facilities,
  routes,
  metricThresholds: {
    temperature: {
      safe: COLD_CHAIN.safeTemperature,
      critical: COLD_CHAIN.criticalTemperature,
      min: 2,
      max: COLD_CHAIN.ambientTemperature,
    },
    viability: { safe: 70, critical: 50, min: 0, max: 100 },
    exposure: { min: 0, max: 400 },
  },
  metricUnits: {
    temperature: '°C',
    viability: '%',
    delay: 'min',
    cost: '₹',
    exposure: '°C·min',
  },
  metrics,
  resources,
  constraints,
  objectives,
  actions,
  initialState: {
    initialCargoTemperature: COLD_CHAIN.baselineTemperature,
    shipmentAllocations: { ...COLD_CHAIN.doses },
    entities: [
      {
        id: 'truck-01',
        kind: 'shipment_vehicle',
        label: 'Vaccine Shipment',
        routeId: 'route-hub-hospital-a',
        progress: 0,
        status: 'en_route',
        active: true,
        payload: { ...COLD_CHAIN.doses },
        refrigerated: true,
        coolingEfficiency: 1,
      },
      {
        id: 'support-01',
        kind: 'support_vehicle',
        label: 'Refrigerated Support Vehicle',
        routeId: 'route-emergency',
        progress: 0,
        status: 'idle',
        active: false,
        refrigerated: true,
        coolingEfficiency: 1,
      },
    ],
  },
  scheduledEvents: [
    {
      id: 'event-refrigeration-failure',
      atMinutes: COLD_CHAIN.failureTimeMinutes,
      type: 'FAILURE',
      eventClass: 'system',
      entityId: 'truck-01',
      focusEntityId: 'truck-01',
      message: 'Refrigeration failure — temperature control lost on the shipment',
      severity: 'critical',
      breaksRefrigeration: ['truck-01'],
      setFlags: { 'failure:occurred': COLD_CHAIN.failureTimeMinutes },
    },
  ],
  stepModels: createColdChainModels(MODEL_CONFIG),
  simulation: {
    timestepMinutes: COLD_CHAIN.timestepMinutes,
    durationMinutes: COLD_CHAIN.durationMinutes,
  },
};

/** Default priorities: the scenario's declared objective weights. */
export const DEFAULT_PRIORITIES: Record<string, number> = objectives.reduce(
  (out, objective) => {
    out[objective.id] = objective.weight;
    return out;
  },
  {} as Record<string, number>,
);

export const STRATEGY_LABELS: Record<string, string> = actions.reduce(
  (out, action) => {
    out[action.id] = action.label;
    return out;
  },
  {} as Record<string, string>,
);

export type StrategyId = 'continue' | 'reroute_storage' | 'emergency_interception' | 'hybrid';

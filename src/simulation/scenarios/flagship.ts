/**
 * Flagship scenario — multi-shipment resource contention (Checkpoint 2).
 *
 *   3 refrigerated shipments, 3 hospitals, 1 hub, 1 support depot.
 *   2 shipments lose refrigeration at the same moment.
 *   1 emergency vehicle can rescue exactly ONE of them.
 *
 * The decision problem: which threatened shipment gets the vehicle? The answer
 * is NOT encoded here. Each allocation is a separate action; the engine
 * simulates every one, scores it against the same objectives, and recommends
 * the best feasible allocation. Swap the shipment sizes / priorities and the
 * recommendation is free to change — it emerges from dose-weighted viability,
 * not from a rule that says "critical always wins".
 *
 * Everything domain-specific is CONFIGURATION. The engine, feasibility, scoring
 * and recommendation are the same ones the cold-chain reference scenario uses.
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
  ScheduledEvent,
  CascadeRule,
} from '../../domain';
import { createColdChainModels, type ColdChainModelConfig } from '../../engine';

/* --------------------------------------------------------------------------- *
 * Constants
 * --------------------------------------------------------------------------- */

export const FLAGSHIP = {
  baselineTemperature: 5,
  ambientTemperature: 26,
  safeTemperature: 8,
  failureRatePerMin: 0.02,
  recoveryRatePerMin: 0.06,
  degradationRate: 0.4,
  timestepMinutes: 5,
  durationMinutes: 140,
  /** Both threatened shipments lose cooling here. */
  failureAtMinutes: 35,
  /** Operator decides once the failure is visible. */
  decisionAtMinutes: 45,
  /** Minutes from the decision until the emergency vehicle reaches its target. */
  interceptMinutes: 12,
  nominalDeliveryMinutes: 105,
} as const;

/** Default demand per hospital. `makeFlagshipScenario` can override this to
 *  demonstrate priority-sensitive allocation. */
export const DEFAULT_DEMAND = {
  'hospital-a': 1500,
  'hospital-b': 1000,
  'hospital-c': 600,
} as const;

/* --------------------------------------------------------------------------- *
 * Topology
 * --------------------------------------------------------------------------- */

const facilities: Facility[] = [
  { id: 'hub', kind: 'hub', label: 'Distribution Hub', position: { x: 8, y: 30 } },
  { id: 'depot', kind: 'hub', label: 'Emergency Depot', position: { x: 30, y: 6 } },
  {
    id: 'hospital-a',
    kind: 'destination',
    label: 'Hospital A',
    position: { x: 88, y: 12 },
    meta: { priority: 'CRITICAL' },
  },
  {
    id: 'hospital-b',
    kind: 'destination',
    label: 'Hospital B',
    position: { x: 88, y: 32 },
    meta: { priority: 'HIGH' },
  },
  {
    id: 'hospital-c',
    kind: 'destination',
    label: 'Hospital C',
    position: { x: 88, y: 52 },
    meta: { priority: 'NORMAL' },
  },
];

const routes: Route[] = [
  { id: 'route-hub-a', from: 'hub', to: 'hospital-a', kind: 'primary', travelTimeMinutes: 105 },
  { id: 'route-hub-b', from: 'hub', to: 'hospital-b', kind: 'primary', travelTimeMinutes: 105 },
  { id: 'route-hub-c', from: 'hub', to: 'hospital-c', kind: 'primary', travelTimeMinutes: 105 },
  { id: 'route-depot-a', from: 'depot', to: 'hospital-a', kind: 'emergency', travelTimeMinutes: 40 },
  { id: 'route-depot-b', from: 'depot', to: 'hospital-b', kind: 'emergency', travelTimeMinutes: 40 },
  { id: 'route-depot-c', from: 'depot', to: 'hospital-c', kind: 'emergency', travelTimeMinutes: 40 },
];

/* --------------------------------------------------------------------------- *
 * Metrics / objectives — same shapes the cold-chain scenario uses
 * --------------------------------------------------------------------------- */

const metrics: MetricDefinition[] = [
  {
    id: 'temperature',
    label: 'Temperature',
    direction: 'minimize',
    aggregation: 'max',
    normalize: { min: FLAGSHIP.baselineTemperature, max: FLAGSHIP.ambientTemperature },
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
    normalize: { min: 0, max: 600 },
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
  {
    id: 'serviceCoverage',
    label: 'Service coverage',
    direction: 'maximize',
    aggregation: 'final',
    normalize: { min: 0, max: 1 },
    unit: '%',
    epsilon: 0.01,
  },
];

const objectives: ObjectiveDefinition[] = [
  { id: 'obj-safety', label: 'Safety', metricId: 'viability', weight: 0.45 },
  { id: 'obj-speed', label: 'Speed', metricId: 'delay', weight: 0.2 },
  { id: 'obj-cost', label: 'Cost', metricId: 'cost', weight: 0.2 },
  { id: 'obj-risk', label: 'Risk', metricId: 'risk', weight: 0.15 },
];

export const FLAGSHIP_OBJECTIVE_IDS = objectives.map((o) => o.id);

const resources: ResourceDefinition[] = [
  {
    id: 'res-emergency-vehicle',
    label: 'Emergency Refrigerated Vehicle',
    kind: 'discrete',
    initial: 1,
    detailFormat: 'count',
  },
  {
    id: 'res-budget',
    label: 'Recovery Budget',
    kind: 'consumable',
    initial: 8,
    capacity: 8,
    unitCost: 100000,
    unit: '₹L',
    detailFormat: 'currency-lakh',
  },
];

const constraints: ConstraintDefinition[] = [
  {
    id: 'constraint-min-viability',
    type: 'viability',
    label: 'Minimum usable viability',
    severity: 'hard',
    scope: 'trajectory',
    operator: '>=',
    value: 8,
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
  {
    id: 'constraint-safe-temperature',
    type: 'temperature',
    label: 'Safe temperature target',
    severity: 'soft',
    scope: 'trajectory',
    operator: '<=',
    value: FLAGSHIP.safeTemperature,
    appliesTo: 'temperature',
  },
  {
    id: 'constraint-viability-target',
    type: 'viability',
    label: 'Viability target',
    severity: 'soft',
    scope: 'trajectory',
    operator: '>=',
    value: 70,
    appliesTo: 'viability',
  },
];

/* --------------------------------------------------------------------------- *
 * Actions — one emergency-vehicle allocation per shipment, plus "hold".
 * --------------------------------------------------------------------------- */

const SHIPMENTS = [
  { entityId: 'ship-a', destinationId: 'hospital-a', label: 'Shipment VX-204', route: 'route-hub-a' },
  { entityId: 'ship-b', destinationId: 'hospital-b', label: 'Shipment VX-317', route: 'route-hub-b' },
  { entityId: 'ship-c', destinationId: 'hospital-c', label: 'Shipment VX-411', route: 'route-hub-c' },
] as const;

const EMERGENCY_BUDGET_LAKH = 1.6;

function holdAction(): ActionDefinition {
  return {
    id: 'hold',
    label: 'Hold — no emergency allocation',
    decisionTimeMinutes: FLAGSHIP.decisionAtMinutes,
    preconditions: [],
    resourceRequirements: [],
    transitions: [],
    apply: (state, ctx) => {
      if (state.flags['hold:noted']) return;
      state.flags['hold:noted'] = ctx.now;
      ctx.emit({
        id: 'hold',
        type: 'DECISION',
        eventClass: 'decision',
        message: 'Operator holds — the emergency vehicle stays in reserve',
        severity: 'warning',
      });
    },
    emittedEvents: [],
    costModel: {},
  };
}

function emergencyAllocation(entityId: string, label: string): ActionDefinition {
  return {
    id: `emergency_${entityId}`,
    label: `Emergency vehicle → ${label}`,
    decisionTimeMinutes: FLAGSHIP.decisionAtMinutes,
    preconditions: [
      {
        kind: 'resource',
        ref: 'res-emergency-vehicle',
        operator: 'available',
        message: 'This allocation needs the emergency vehicle, and it is not available.',
      },
    ],
    resourceRequirements: [
      { resourceId: 'res-emergency-vehicle', amount: 1 },
      { resourceId: 'res-budget', amount: EMERGENCY_BUDGET_LAKH },
    ],
    transitions: [
      { target: 'resource', id: 'res-budget', op: 'allocate', value: EMERGENCY_BUDGET_LAKH },
      { target: 'resource', id: 'res-emergency-vehicle', op: 'allocate', value: 1 },
    ],
    apply: (state, ctx) => {
      const target = state.entities[entityId];
      if (!target) return;
      if (ctx.sinceDecision < FLAGSHIP.interceptMinutes) return;
      if (state.flags['emergency:done']) return;

      state.flags['emergency:done'] = ctx.now;
      state.flags[`emergency:target`] = entityId;
      // The scarce vehicle restores cooling for exactly this shipment. Every
      // other shipment is left exactly as it was — that is the contention.
      target.refrigerated = true;
      target.coolingEfficiency = 1;
      target.status = 'recovering';

      ctx.emit({
        id: 'interception',
        type: 'INTERCEPTION',
        eventClass: 'system',
        entityId,
        message: `Emergency vehicle reaches ${label} — cooling restored`,
        severity: 'info',
        focusEntityId: entityId,
      });
      ctx.emit({
        id: 'recovery',
        type: 'RECOVERY',
        eventClass: 'system',
        entityId,
        message: `${label} temperature trending back toward the safe range`,
        severity: 'info',
        focusEntityId: entityId,
      });
    },
    emittedEvents: [
      {
        id: 'dispatch',
        type: 'VEHICLE_DISPATCHED',
        eventClass: 'decision',
        atOffsetMinutes: 0,
        entityId,
        resourceId: 'res-emergency-vehicle',
        message: `Emergency vehicle dispatched to ${label}`,
        severity: 'info',
        focusEntityId: entityId,
      },
    ],
    costModel: { perResource: { 'res-budget': 100000 } },
  };
}

const actions: ActionDefinition[] = [
  holdAction(),
  ...SHIPMENTS.map((s) => emergencyAllocation(s.entityId, s.label)),
];

/* --------------------------------------------------------------------------- *
 * Cascade chain (Checkpoint 3) — the flagship consequence chain:
 *   refrigeration failure -> viability degrades -> shipment at risk ->
 *   emergency-resource contention flagged
 * --------------------------------------------------------------------------- */

const cascadeRules: CascadeRule[] = [
  {
    id: 'cascade-viability-risk',
    label: 'Shipment viability degrading',
    trigger: { kind: 'metric', metric: 'viability', operator: '<', threshold: 85 },
    once: true,
    effect: { setFlags: { 'shipment:at-risk': 1 } },
    emit: {
      type: 'THRESHOLD_CROSSED',
      eventClass: 'system',
      message: 'Aggregate shipment viability falling — shipments at risk',
      severity: 'warning',
    },
    sourceId: 'viability',
  },
  {
    id: 'cascade-contention',
    label: 'Emergency resource contested',
    trigger: { kind: 'state', flag: 'shipment:at-risk', operator: '>=', threshold: 1 },
    delayMinutes: 5,
    once: true,
    emit: {
      type: 'CONSTRAINT_VIOLATED',
      eventClass: 'system',
      message:
        'Multiple shipments require intervention — one emergency vehicle available. Decision required.',
      severity: 'critical',
    },
    sourceId: 'res-emergency-vehicle',
  },
];

/* --------------------------------------------------------------------------- *
 * Scenario factory
 * --------------------------------------------------------------------------- */

export interface FlagshipOptions {
  /** Override demand per hospital — used to show priority-sensitive allocation. */
  demand?: Partial<Record<'hospital-a' | 'hospital-b' | 'hospital-c', number>>;
  /** Which shipments lose refrigeration. Default: A and B. */
  failing?: Array<'ship-a' | 'ship-b' | 'ship-c'>;
  /** Make the emergency vehicle unavailable (contention with no good answer). */
  emergencyVehicleAvailable?: boolean;
}

export function makeFlagshipScenario(options: FlagshipOptions = {}): ScenarioConfig {
  const demand = { ...DEFAULT_DEMAND, ...options.demand };
  const failing = options.failing ?? ['ship-a', 'ship-b'];
  const totalDemand = demand['hospital-a'] + demand['hospital-b'] + demand['hospital-c'];

  const modelConfig: ColdChainModelConfig = {
    baselineTemperature: FLAGSHIP.baselineTemperature,
    ambientTemperature: FLAGSHIP.ambientTemperature,
    safeTemperature: FLAGSHIP.safeTemperature,
    failureRatePerMin: FLAGSHIP.failureRatePerMin,
    recoveryRatePerMin: FLAGSHIP.recoveryRatePerMin,
    degradationRate: FLAGSHIP.degradationRate,
    nominalDeliveryMinutes: FLAGSHIP.nominalDeliveryMinutes,
    totalDemandDoses: totalDemand,
    riskBands: { low: 85, moderate: 70, high: 50 },
  };

  const scheduledEvents: ScheduledEvent[] = [
    {
      id: 'event-refrigeration-failure',
      atMinutes: FLAGSHIP.failureAtMinutes,
      type: 'FAILURE',
      eventClass: 'system',
      message: `Refrigeration failure — cooling lost on ${failing.length} shipments`,
      severity: 'critical',
      breaksRefrigeration: [...failing],
      setFlags: { 'failure:occurred': FLAGSHIP.failureAtMinutes },
      focusEntityId: failing[0],
    },
  ];

  const resourceDefs: ResourceDefinition[] = resources.map((r) =>
    r.id === 'res-emergency-vehicle' && options.emergencyVehicleAvailable === false
      ? { ...r, initial: 0 }
      : r,
  );

  return {
    id: 'flagship-contention',
    version: 1,
    title: 'Multi-Shipment Emergency Allocation',
    facilities,
    routes,
    metricThresholds: {
      temperature: { safe: 8, critical: 14, min: 2, max: 26 },
      viability: { safe: 70, critical: 50, min: 0, max: 100 },
    },
    metricUnits: { temperature: '°C', viability: '%', delay: 'min', cost: '₹' },
    metrics,
    resources: resourceDefs,
    constraints,
    objectives,
    actions,
    initialState: {
      initialCargoTemperature: FLAGSHIP.baselineTemperature,
      shipmentAllocations: {
        'hospital-a': demand['hospital-a'],
        'hospital-b': demand['hospital-b'],
        'hospital-c': demand['hospital-c'],
      },
      entities: SHIPMENTS.map((s) => ({
        id: s.entityId,
        kind: 'shipment_vehicle',
        label: s.label,
        routeId: s.route,
        progress: 0,
        status: 'en_route',
        active: true,
        payload: { [s.destinationId]: demand[s.destinationId as keyof typeof demand] },
        refrigerated: true,
        coolingEfficiency: 1,
      })),
    },
    scheduledEvents,
    cascadeRules,
    stepModels: createColdChainModels(modelConfig),
    simulation: {
      timestepMinutes: FLAGSHIP.timestepMinutes,
      durationMinutes: FLAGSHIP.durationMinutes,
    },
  };
}

export const flagshipScenario: ScenarioConfig = makeFlagshipScenario();

export const FLAGSHIP_STRATEGY_LABELS: Record<string, string> = actions.reduce(
  (out, a) => {
    out[a.id] = a.label;
    return out;
  },
  {} as Record<string, string>,
);

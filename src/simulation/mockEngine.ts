/**
 * MOCK simulation engine — a deterministic STAND-IN implementing the
 * `SimulationResult` contract in `types.ts`.
 *
 * The real simulation / decision engine (owned by another teammate) replaces
 * this file. Every consumer in the visualization layer depends only on the
 * exported types, so the swap requires no component changes.
 *
 * Guarantees: `runMockSimulation(scenario, strategy, inputs)` is deterministic —
 * identical arguments produce a byte-identical result (event ids, timestamps,
 * metric series). This makes replay a product feature, not an accident.
 *
 * None of the numbers here are medically meaningful. They are plausible-looking
 * trajectories for demonstrating the visualization.
 */

import {
  DECISION_TYPES,
  type DecisionImpact,
  type EntityState,
  type ResourceState,
  type ScenarioConfig,
  type SimulationEvent,
  type SimulationResult,
  type SimulationStep,
  type StepMetrics,
} from './types';

export type StrategyId =
  | 'continue'
  | 'reroute_storage'
  | 'emergency_interception'
  | 'hybrid';

export interface WhatIfInputs {
  /** 0..100 — how much the operator weights shipment safety. */
  safetyPriority?: number;
  /** Available budget in ₹ lakh. */
  budgetLakh?: number;
  /** Whether a support vehicle is available to dispatch. */
  supportVehicleAvailable?: boolean;
}

const STEP_MINUTES = 5;
const HORIZON_MINUTES = 120;
const SAFE_TEMP = 8;
const BASELINE_TEMP = 5;
const FAILURE_TIME = 35;

/* --------------------------------------------------------------------------- *
 * Deterministic RNG (mulberry32) — used only for tiny visual jitter.
 * --------------------------------------------------------------------------- */

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* --------------------------------------------------------------------------- *
 * Reference cold-chain scenario.
 * --------------------------------------------------------------------------- */

export const coldChainScenario: ScenarioConfig = {
  id: 'cold-chain-recovery',
  title: 'Cold-Chain Vaccine Recovery',
  facilities: [
    { id: 'hub', kind: 'hub', label: 'Distribution Hub', position: { x: 8, y: 30 } },
    {
      id: 'hospital-a',
      kind: 'destination',
      label: 'Hospital A',
      position: { x: 88, y: 12 },
      capacity: { capacity: 1200, used: 0, unit: 'doses' },
      meta: { priority: 'HIGH' },
    },
    {
      id: 'hospital-b',
      kind: 'destination',
      label: 'Hospital B',
      position: { x: 88, y: 46 },
      capacity: { capacity: 900, used: 0, unit: 'doses' },
      meta: { priority: 'MEDIUM' },
    },
    {
      id: 'cold-storage',
      kind: 'storage',
      label: 'Cold Storage',
      position: { x: 50, y: 54 },
      capacity: { capacity: 5000, used: 4200, unit: 'doses' },
    },
    {
      id: 'support-depot',
      kind: 'hub',
      label: 'Support Depot',
      position: { x: 34, y: 6 },
    },
  ],
  routes: [
    {
      id: 'route-hub-hospital-a',
      from: 'hub',
      to: 'hospital-a',
      kind: 'primary',
      waypoints: [
        { x: 8, y: 30 },
        { x: 40, y: 22 },
        { x: 66, y: 18 },
        { x: 88, y: 12 },
      ],
    },
    {
      id: 'route-hub-storage',
      from: 'hub',
      to: 'cold-storage',
      kind: 'reroute',
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
      waypoints: [
        { x: 34, y: 6 },
        { x: 52, y: 14 },
        { x: 66, y: 18 },
      ],
    },
  ],
  metricThresholds: {
    temperature: { safe: SAFE_TEMP, critical: 14, min: 2, max: 18 },
    viability: { safe: 70, critical: 50, min: 0, max: 100 },
  },
  metricUnits: { temperature: '°C', viability: '%', delay: 'min', cost: '₹' },
};

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  continue: 'Continue Delivery',
  reroute_storage: 'Reroute to Cold Storage',
  emergency_interception: 'Emergency Interception',
  hybrid: 'Hybrid Recovery',
};

/* --------------------------------------------------------------------------- *
 * Per-strategy keyframes.
 * --------------------------------------------------------------------------- */

interface StrategyPlan {
  decisionTime: number;
  decisionType: SimulationEvent['type'];
  decisionMessage: string;
  /** When temperature control is effectively restored (interception / transfer). */
  stabilizeTime: number | null;
  stabilizeType: SimulationEvent['type'] | null;
  stabilizeMessage: string | null;
  deliveryTime: number;
  usesSupportVehicle: boolean;
  reroutesThroughStorage: boolean;
  outcomeStatus: SimulationResult['outcome']['status'];
}

function planFor(strategy: StrategyId, inputs: WhatIfInputs): StrategyPlan {
  const supportOk = inputs.supportVehicleAvailable !== false;
  switch (strategy) {
    case 'continue':
      return {
        decisionTime: 40,
        decisionType: 'DECISION',
        decisionMessage: 'Operator elects to continue delivery on the primary route',
        stabilizeTime: null,
        stabilizeType: null,
        stabilizeMessage: null,
        deliveryTime: 78,
        usesSupportVehicle: false,
        reroutesThroughStorage: false,
        outcomeStatus: 'partial',
      };
    case 'reroute_storage':
      return {
        decisionTime: 42,
        decisionType: 'REROUTE',
        decisionMessage: 'Shipment rerouted to cold storage for stabilization',
        stabilizeTime: 66,
        stabilizeType: 'STORAGE_TRANSFER',
        stabilizeMessage: 'Shipment transferred into cold storage — temperature recovering',
        deliveryTime: 108,
        usesSupportVehicle: false,
        reroutesThroughStorage: true,
        outcomeStatus: 'success',
      };
    case 'emergency_interception':
      return {
        decisionTime: 40,
        decisionType: 'VEHICLE_DISPATCHED',
        decisionMessage: 'Refrigerated support vehicle dispatched from Support Depot',
        stabilizeTime: 58,
        stabilizeType: 'INTERCEPTION',
        stabilizeMessage: 'Support vehicle intercepts shipment — cargo re-cooled in transit',
        deliveryTime: 86,
        usesSupportVehicle: supportOk,
        reroutesThroughStorage: false,
        outcomeStatus: supportOk ? 'success' : 'failed',
      };
    case 'hybrid':
    default:
      return {
        decisionTime: 41,
        decisionType: 'VEHICLE_DISPATCHED',
        decisionMessage: 'Support vehicle dispatched while shipment diverts toward storage corridor',
        stabilizeTime: 60,
        stabilizeType: 'INTERCEPTION',
        stabilizeMessage: 'Support vehicle meets shipment near the storage corridor',
        deliveryTime: 96,
        usesSupportVehicle: supportOk,
        reroutesThroughStorage: true,
        outcomeStatus: supportOk ? 'success' : 'partial',
      };
  }
}

/* --------------------------------------------------------------------------- *
 * Metric models (visual only).
 * --------------------------------------------------------------------------- */

function temperatureAt(t: number, plan: StrategyPlan): number {
  if (t < FAILURE_TIME) return BASELINE_TEMP;
  const rise = Math.min(9, (t - FAILURE_TIME) * 0.26);
  let temp = BASELINE_TEMP + rise;
  if (plan.stabilizeTime != null && t > plan.stabilizeTime) {
    const cooled = (t - plan.stabilizeTime) * 0.32;
    const peak = BASELINE_TEMP + Math.min(9, (plan.stabilizeTime - FAILURE_TIME) * 0.26);
    temp = Math.max(BASELINE_TEMP + 1, peak - cooled);
  }
  return Math.round(temp * 10) / 10;
}

function buildViabilitySeries(times: number[], plan: StrategyPlan): number[] {
  const out: number[] = [];
  let viability = 100;
  let prev = times[0];
  for (const t of times) {
    const dt = t - prev;
    const temp = temperatureAt(t, plan);
    if (temp > SAFE_TEMP && dt > 0) {
      viability -= (temp - SAFE_TEMP) * 0.16 * dt;
    }
    viability = Math.max(0, Math.min(100, viability));
    out.push(Math.round(viability * 10) / 10);
    prev = t;
  }
  return out;
}

function riskLabel(viability: number): string {
  if (viability >= 85) return 'LOW';
  if (viability >= 70) return 'MODERATE';
  if (viability >= 50) return 'HIGH';
  return 'CRITICAL';
}

function riskScore(viability: number): number {
  if (viability >= 85) return 1;
  if (viability >= 70) return 2;
  if (viability >= 50) return 3;
  return 4;
}

/* --------------------------------------------------------------------------- *
 * Entity trajectories.
 * --------------------------------------------------------------------------- */

interface TruckLeg {
  routeId: string;
  startTime: number;
  endTime: number;
}

function truckLegs(plan: StrategyPlan): TruckLeg[] {
  if (!plan.reroutesThroughStorage) {
    return [{ routeId: 'route-hub-hospital-a', startTime: 0, endTime: plan.deliveryTime }];
  }
  const transfer = plan.stabilizeTime ?? plan.decisionTime + 20;
  return [
    { routeId: 'route-hub-storage', startTime: 0, endTime: transfer },
    { routeId: 'route-storage-hospital-a', startTime: transfer, endTime: plan.deliveryTime },
  ];
}

function truckStateAt(
  t: number,
  plan: StrategyPlan,
  legs: TruckLeg[],
  failed: boolean,
  stabilized: boolean,
): EntityState {
  const leg = legs.find((l) => t <= l.endTime) ?? legs[legs.length - 1];
  const span = Math.max(1, leg.endTime - leg.startTime);
  const progress = Math.max(0, Math.min(1, (t - leg.startTime) / span));

  let status = 'en_route';
  if (t >= plan.deliveryTime) status = 'delivered';
  else if (t >= plan.deliveryTime - 8) status = 'delivering';
  else if (failed && !stabilized) status = 'refrigeration_failed';
  else if (stabilized) status = 'recovering';

  return {
    id: 'truck-01',
    kind: 'shipment_vehicle',
    label: 'Vaccine Shipment',
    routeId: leg.routeId,
    progress,
    status,
    active: true,
  };
}

function supportStateAt(t: number, plan: StrategyPlan): EntityState | null {
  if (!plan.usesSupportVehicle) return null;
  const dispatch = plan.decisionTime;
  const meet = plan.stabilizeTime ?? dispatch + 18;
  if (t < dispatch) {
    return {
      id: 'support-01',
      kind: 'support_vehicle',
      label: 'Refrigerated Support Vehicle',
      routeId: 'route-emergency',
      progress: 0,
      status: 'idle',
      active: false,
    };
  }
  if (t < meet) {
    const progress = Math.max(0, Math.min(1, (t - dispatch) / Math.max(1, meet - dispatch)));
    return {
      id: 'support-01',
      kind: 'support_vehicle',
      label: 'Refrigerated Support Vehicle',
      routeId: 'route-emergency',
      progress,
      status: 'dispatched',
      active: true,
    };
  }
  // After interception the support vehicle escorts the shipment to delivery.
  if (t < plan.deliveryTime) {
    return {
      id: 'support-01',
      kind: 'support_vehicle',
      label: 'Refrigerated Support Vehicle',
      routeId: 'route-emergency',
      progress: 1,
      status: 'escorting',
      active: true,
    };
  }
  return {
    id: 'support-01',
    kind: 'support_vehicle',
    label: 'Refrigerated Support Vehicle',
    routeId: 'route-emergency',
    progress: 1,
    status: 'returning',
    active: false,
  };
}

/* --------------------------------------------------------------------------- *
 * Resources.
 * --------------------------------------------------------------------------- */

function resourcesAt(t: number, plan: StrategyPlan, inputs: WhatIfInputs): ResourceState[] {
  const budget = inputs.budgetLakh ?? 8;
  const spent = t >= plan.decisionTime ? (plan.usesSupportVehicle ? 2.6 : plan.reroutesThroughStorage ? 1.2 : 0.4) : 0;
  const storageUsed = 4200 + (plan.reroutesThroughStorage && plan.stabilizeTime != null && t >= plan.stabilizeTime ? 300 : 0);

  const vehicle: ResourceState = {
    id: 'res-support-vehicle',
    label: 'Support Vehicle',
    status: !plan.usesSupportVehicle
      ? inputs.supportVehicleAvailable === false
        ? 'unavailable'
        : 'available'
      : t >= plan.decisionTime
        ? t >= plan.deliveryTime
          ? 'available'
          : 'allocated'
        : 'available',
    detail: !plan.usesSupportVehicle
      ? inputs.supportVehicleAvailable === false
        ? 'Not available for this run'
        : 'Standby at Support Depot'
      : t >= plan.decisionTime && t < plan.deliveryTime
        ? 'Deployed — en route / escorting'
        : 'Standby at Support Depot',
  };

  const storage: ResourceState = {
    id: 'res-cold-storage',
    label: 'Cold Storage',
    status: storageUsed >= 5000 ? 'depleted' : 'available',
    detail: `${storageUsed.toLocaleString()} / 5,000 doses`,
  };

  const budgetRes: ResourceState = {
    id: 'res-budget',
    label: 'Recovery Budget',
    status: spent >= budget ? 'depleted' : spent > 0 ? 'allocated' : 'available',
    detail: `₹${(budget - spent).toFixed(1)}L of ₹${budget.toFixed(1)}L remaining`,
  };

  return [vehicle, storage, budgetRes];
}

/* --------------------------------------------------------------------------- *
 * Main entry point.
 * --------------------------------------------------------------------------- */

export function runMockSimulation(
  scenario: ScenarioConfig,
  strategy: StrategyId,
  inputs: WhatIfInputs = {},
  runNumber = 1,
): SimulationResult {
  const seed = hashString(`${strategy}:${JSON.stringify(inputs)}`);
  const rng = mulberry32(seed);
  void rng; // reserved for future jitter; kept deterministic

  const plan = planFor(strategy, inputs);
  const legs = truckLegs(plan);

  const times: number[] = [];
  for (let t = 0; t <= HORIZON_MINUTES; t += STEP_MINUTES) times.push(t);
  const viabilitySeries = buildViabilitySeries(times, plan);

  /* ----- events ----- */
  const events: SimulationEvent[] = [];
  events.push({
    id: 'event-refrigeration-failure',
    timestamp: FAILURE_TIME,
    type: 'FAILURE',
    eventClass: 'system',
    entityId: 'truck-01',
    message: 'Refrigeration failure — temperature control lost on the shipment',
    severity: 'critical',
    focusEntityId: 'truck-01',
  });

  const thresholdTime = times.find((t, i) => t > FAILURE_TIME && viabilitySeries[i] < 100 && temperatureAt(t, plan) > SAFE_TEMP);
  if (thresholdTime != null) {
    events.push({
      id: 'event-threshold-crossed',
      timestamp: thresholdTime,
      type: 'THRESHOLD_CROSSED',
      eventClass: 'system',
      entityId: 'truck-01',
      message: 'Cargo temperature exceeded the safe threshold — viability now decreasing',
      severity: 'warning',
      focusEntityId: 'truck-01',
    });
  }

  events.push({
    id: 'event-decision',
    timestamp: plan.decisionTime,
    type: plan.decisionType,
    eventClass: 'decision',
    entityId: plan.usesSupportVehicle ? 'support-01' : 'truck-01',
    routeId: plan.reroutesThroughStorage ? 'route-hub-storage' : undefined,
    message: plan.decisionMessage,
    severity: 'info',
    focusEntityId: plan.usesSupportVehicle ? 'support-01' : 'truck-01',
  });

  if (plan.reroutesThroughStorage) {
    events.push({
      id: 'event-reroute',
      timestamp: plan.decisionTime + 0.5,
      type: 'REROUTE',
      eventClass: 'decision',
      entityId: 'truck-01',
      routeId: 'route-hub-storage',
      message: 'Shipment route switched toward the cold-storage corridor',
      severity: 'info',
      focusEntityId: 'truck-01',
    });
  }

  if (plan.usesSupportVehicle) {
    events.push({
      id: 'event-resource-allocated',
      timestamp: plan.decisionTime + 0.5,
      type: 'RESOURCE_ALLOCATED',
      eventClass: 'decision',
      resourceId: 'res-support-vehicle',
      entityId: 'support-01',
      message: 'Support vehicle and recovery budget allocated',
      severity: 'info',
    });
  }

  if (plan.stabilizeTime != null && plan.stabilizeType != null) {
    events.push({
      id: 'event-stabilize',
      timestamp: plan.stabilizeTime,
      type: plan.stabilizeType,
      eventClass: plan.stabilizeType === 'STORAGE_TRANSFER' ? 'decision' : 'system',
      entityId: 'truck-01',
      facilityId: plan.stabilizeType === 'STORAGE_TRANSFER' ? 'cold-storage' : undefined,
      message: plan.stabilizeMessage ?? 'Temperature stabilized',
      severity: 'info',
      focusEntityId: 'truck-01',
    });
    events.push({
      id: 'event-recovery',
      timestamp: plan.stabilizeTime + STEP_MINUTES,
      type: 'RECOVERY',
      eventClass: 'system',
      entityId: 'truck-01',
      message: 'Cargo temperature trending back toward the safe range',
      severity: 'info',
      focusEntityId: 'truck-01',
    });
  }

  events.push({
    id: 'event-delivery',
    timestamp: plan.deliveryTime,
    type: 'DELIVERY',
    eventClass: 'system',
    entityId: 'truck-01',
    facilityId: 'hospital-a',
    message:
      plan.outcomeStatus === 'failed'
        ? 'Shipment reached Hospital A but viability is below the usable threshold'
        : 'Shipment delivered to Hospital A',
    severity: plan.outcomeStatus === 'failed' ? 'critical' : 'info',
    focusEntityId: 'truck-01',
  });

  events.sort((a, b) => a.timestamp - b.timestamp);

  /* ----- steps ----- */
  const steps: SimulationStep[] = times.map((t, i) => {
    const failed = t >= FAILURE_TIME;
    const stabilized = plan.stabilizeTime != null && t >= plan.stabilizeTime;
    const temperature = temperatureAt(t, plan);
    const viability = viabilitySeries[i];
    const entities: EntityState[] = [truckStateAt(t, plan, legs, failed, stabilized)];
    const support = supportStateAt(t, plan);
    if (support) entities.push(support);

    const metrics: StepMetrics = {
      temperature,
      viability,
      risk: riskScore(viability),
      delay: Math.max(0, Math.round(plan.deliveryTime - 62)),
      cost:
        t >= plan.decisionTime
          ? plan.usesSupportVehicle
            ? 260000
            : plan.reroutesThroughStorage
              ? 120000
              : 40000
          : 0,
    };

    const stepEvents = events.filter(
      (e) => e.timestamp > t - STEP_MINUTES && e.timestamp <= t + 1e-6,
    );

    return {
      timestamp: t,
      entities,
      resources: resourcesAt(t, plan, inputs),
      metrics,
      events: stepEvents,
    };
  });

  /* ----- outcome + decision impact ----- */
  const finalViability = viabilitySeries[viabilitySeries.length - 1];
  const finalStep = steps[steps.length - 1];
  const finalMetrics: StepMetrics = { ...finalStep.metrics };

  const decisionEvent = events.find((e) => e.eventClass === 'decision');
  const decisionIndex = times.findIndex((t) => t >= plan.decisionTime);
  const beforeStep = steps[Math.max(0, decisionIndex)];
  const decisionImpact: DecisionImpact | undefined = decisionEvent
    ? {
        decisionEventId: decisionEvent.id,
        before: { ...beforeStep.metrics },
        projected: finalMetrics,
        riskBefore: riskLabel(beforeStep.metrics.viability ?? 100),
        riskAfter: riskLabel(finalViability),
      }
    : undefined;

  const strategyLabel = STRATEGY_LABELS[strategy];

  return {
    run: {
      runId: `run-${String(runNumber).padStart(3, '0')}`,
      runNumber,
      label: strategyLabel,
      inputs: {
        strategy,
        safetyPriority: inputs.safetyPriority ?? 50,
        budgetLakh: inputs.budgetLakh ?? 8,
        supportVehicle: inputs.supportVehicleAvailable === false ? 'unavailable' : 'available',
      },
      seed,
    },
    scenario,
    strategy,
    duration: HORIZON_MINUTES,
    steps,
    events,
    outcome: {
      strategy: strategyLabel,
      status: plan.outcomeStatus,
      summary:
        plan.outcomeStatus === 'success'
          ? `${strategyLabel}: shipment delivered with ${finalViability.toFixed(0)}% viability retained.`
          : plan.outcomeStatus === 'partial'
            ? `${strategyLabel}: shipment delivered but only ${finalViability.toFixed(0)}% viability retained.`
            : `${strategyLabel}: intervention infeasible — shipment viability dropped to ${finalViability.toFixed(0)}%.`,
      finalMetrics,
    },
    decisionImpact,
    sensitivity: [
      { label: 'Remaining Viability', weight: 0.43 },
      { label: 'Safety Priority', weight: 0.31 },
      { label: 'Vehicle Availability', weight: 0.17 },
      { label: 'Budget', weight: 0.09 },
    ],
    tradeoffs: [
      { strategy: 'Continue Delivery', scores: { Cost: 2, Speed: 1, Risk: -1, Safety: -1 } },
      { strategy: 'Reroute to Cold Storage', scores: { Cost: 1, Speed: -1, Risk: 1, Safety: 2 } },
      { strategy: 'Emergency Interception', scores: { Cost: -1, Speed: 2, Risk: 1, Safety: 2 } },
      { strategy: 'Hybrid Recovery', scores: { Cost: -1, Speed: 1, Risk: 1, Safety: 2 } },
    ],
  };
}

/** Convenience helper used by the demo harness. */
export function isDecisionType(type: string): boolean {
  return DECISION_TYPES.includes(type);
}

/**
 * Presentation layer over the engine's structured events.
 *
 * The engine emits technical events (FAILURE, THRESHOLD_CROSSED, INTERCEPTION…).
 * This module maps them to operator-facing language and marks the few that are
 * important enough to narrate aloud. It reads event metadata only — it never
 * invents an outcome and never hard-codes a scenario script.
 */

import type {
  ConstraintViolation,
  SimulationEvent,
  SimulationResult,
} from './types';

export type NarrativeTone = 'normal' | 'warning' | 'critical' | 'ok' | 'decision';

export interface NarrativeLine {
  id: string;
  atMinutes: number;
  headline: string;
  detail?: string;
  tone: NarrativeTone;
  /** Set when this line is worth speaking aloud. */
  speak?: string;
}

/** How an engine event reads on the incident timeline. */
export function describeEvent(event: SimulationEvent): NarrativeLine {
  const base = { id: event.id, atMinutes: event.timestamp };
  switch (event.type) {
    case 'FAILURE':
      return {
        ...base,
        headline: 'Refrigeration failure detected',
        detail: 'Primary vehicle has lost temperature control.',
        tone: 'critical',
        speak: 'Alert. Refrigeration failure detected on the primary vehicle.',
      };
    case 'THRESHOLD_CROSSED':
      return {
        ...base,
        headline: /blockage|impassable/i.test(event.message)
          ? 'Shipment held at blockage'
          : 'Entering the critical temperature zone',
        detail: /blockage|impassable/i.test(event.message)
          ? 'No forward progress on the current corridor.'
          : 'Cargo temperature has crossed the safe operating range.',
        tone: 'warning',
      };
    case 'CONSTRAINT_VIOLATED':
      return {
        ...base,
        headline: /blockage|impassable/i.test(event.message)
          ? 'Primary corridor unavailable'
          : 'Operating limit breached',
        detail: 'An alternate delivery path is required.',
        tone: 'critical',
        speak: 'Primary corridor is now blocked. An alternate route is required.',
      };
    case 'VEHICLE_DISPATCHED':
      return {
        ...base,
        headline: 'Support vehicle dispatched',
        detail: 'Refrigerated support asset en route to intercept.',
        tone: 'decision',
      };
    case 'RESOURCE_ALLOCATED':
      return { ...base, headline: 'Recovery resources committed', tone: 'decision' };
    case 'REROUTE':
      return {
        ...base,
        headline: /detour/i.test(event.message)
          ? 'Shipment diverted onto the recovery corridor'
          : 'Shipment rerouted to a regional cold store',
        tone: 'decision',
      };
    case 'INTERCEPTION':
      return {
        ...base,
        headline: /partition/i.test(event.message)
          ? 'Shipment partitioned between vehicles'
          : 'Emergency vehicle has intercepted the shipment',
        detail: 'Cargo cooling is being restored in transit.',
        tone: 'ok',
        speak: 'Recovery intervention initiated.',
      };
    case 'STORAGE_TRANSFER':
      return {
        ...base,
        headline: 'Cargo moved into cold storage',
        detail: 'Temperature control restored.',
        tone: 'ok',
      };
    case 'RECOVERY':
      return {
        ...base,
        headline: 'Cargo stabilising',
        detail: 'Temperature trending back toward the safe range.',
        tone: 'ok',
        speak: 'Shipment stabilised. Delivery remains feasible.',
      };
    case 'DELIVERY':
      return {
        ...base,
        headline: /Hospital B/i.test(event.message)
          ? 'Secondary destination delivered'
          : 'Shipment delivered successfully',
        tone: 'ok',
        speak: /Hospital B/i.test(event.message) ? undefined : 'Shipment delivered successfully.',
      };
    case 'DECISION':
      return { ...base, headline: 'Operator decision recorded', tone: 'decision' };
    default:
      return { ...base, headline: event.message, tone: 'normal' };
  }
}

/** Compact incident timeline: one narrative line per event up to `t`. */
export function incidentTimeline(result: SimulationResult, t: number): NarrativeLine[] {
  return result.events
    .filter((e) => e.timestamp <= t + 1e-6)
    .map(describeEvent);
}

/* --------------------------------------------------------------------------- *
 * Constraint translation — technical failure -> operational pressure.
 * --------------------------------------------------------------------------- */

export interface OperationalConstraint {
  title: string;
  detail: string;
  constraintId: string;
}

export function translateViolation(v: ConstraintViolation): OperationalConstraint {
  const map: Record<string, { title: string; detail: (v: ConstraintViolation) => string }> = {
    'constraint-critical-temperature': {
      title: 'Cold-chain limit',
      detail: (x) => `Projected temperature reaches ${fmt(x.actual)}°C (limit ${x.expected}°C).`,
    },
    'constraint-min-viability': {
      title: 'Product integrity',
      detail: (x) => `Projected viability falls to ${fmt(x.actual)}% (floor ${x.expected}%).`,
    },
    'constraint-final-coverage': {
      title: 'Delivery requirement',
      detail: () => 'Shipment cannot reach every destination within the horizon.',
    },
    'constraint-final-viability': {
      title: 'Usable on arrival',
      detail: (x) => `Viability on delivery would be ${fmt(x.actual)}% (need ${x.expected}%).`,
    },
    'constraint-max-delay': {
      title: 'Delivery window',
      detail: (x) => `Delay reaches ${fmt(x.actual)} min (target ${x.expected}).`,
    },
    'constraint-safe-temperature': {
      title: 'Safe temperature target',
      detail: (x) => `Cargo spends time above ${x.expected}°C (peak ${fmt(x.actual)}°C).`,
    },
  };
  const entry = map[v.constraintId];
  if (entry) return { title: entry.title, detail: entry.detail(v), constraintId: v.constraintId };
  if (/precondition|resource/.test(v.constraintId)) {
    return { title: 'Resource limit', detail: v.message, constraintId: v.constraintId };
  }
  return { title: v.label, detail: v.message, constraintId: v.constraintId };
}

function fmt(value: number | string | boolean): string {
  if (typeof value !== 'number') return String(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/* --------------------------------------------------------------------------- *
 * Decision window — when does doing nothing become unrecoverable?
 * --------------------------------------------------------------------------- */

export interface DecisionWindow {
  /** Minute the "do nothing" trajectory first breaches a hard limit. */
  breachAtMinutes: number | null;
  /** Which limit it breaches first. */
  reason: string;
}

/**
 * Walk the do-nothing (Continue) trajectory and find the first minute it
 * violates the cold-chain or viability limit. That is the operator's window.
 */
export function decisionWindow(doNothing: SimulationResult): DecisionWindow {
  const tempLimit =
    doNothing.scenario.constraints.find((c) => c.id === 'constraint-critical-temperature')
      ?.value ?? 14;
  const viaFloor =
    doNothing.scenario.constraints.find((c) => c.id === 'constraint-min-viability')?.value ?? 30;

  for (const step of doNothing.steps) {
    const temp = step.metrics.temperature ?? 0;
    const via = step.metrics.viability ?? 100;
    if (typeof tempLimit === 'number' && temp > tempLimit) {
      return { breachAtMinutes: step.timestamp, reason: `temperature exceeds ${tempLimit}°C` };
    }
    if (typeof viaFloor === 'number' && via < viaFloor) {
      return { breachAtMinutes: step.timestamp, reason: `viability drops below ${viaFloor}%` };
    }
  }
  return { breachAtMinutes: null, reason: 'no hard limit breached' };
}

/**
 * An action is a state transformation. It never returns "safety = 94"; it
 * performs operations that cause the simulation to produce those metrics.
 *
 * Two mechanisms, deliberately:
 *
 *   transitions[] — declarative, covers the common cases (switch a route,
 *                   allocate a resource, set a status or flag). Data, so it is
 *                   inspectable and serializable.
 *
 *   apply?        — an optional handler for domain-rich transformations that a
 *                   generic `target + op + value` vocabulary would only express
 *                   awkwardly: splitting a shipment across destinations,
 *                   allocating quantities, partitioning cargo between an
 *                   emergency vehicle and cold storage.
 *
 * The escape hatch exists so this codebase never has to grow a fake universal
 * workflow language. Most actions stay declarative; the interesting one doesn't
 * have to.
 */

import type { ConstraintOperator } from './constraint';
import type { EventClass, EventSeverity, SimulationEventType } from './events';
import type { SimulationInputs } from './inputs';
import type { ResourceRequirement } from './resource';
import type { SimulationState } from './state';

export interface Precondition {
  kind: 'resource' | 'flag' | 'metric';
  /** Resource id, flag name or metric key. */
  ref: string;
  operator: ConstraintOperator;
  value?: number | string | boolean;
  /** Overrides the generated violation message. */
  message?: string;
}

export type TransitionTarget = 'entity' | 'resource' | 'facility' | 'flag';

export type TransitionOp =
  | 'route-switch'
  | 'set-status'
  | 'set-active'
  | 'allocate'
  | 'release'
  | 'set-flag'
  | 'add';

export interface StateTransition {
  target: TransitionTarget;
  /** Entity/resource/facility id, or flag name. */
  id: string;
  op: TransitionOp;
  value?: number | string | boolean;
  /** Minutes after the decision time at which this transition fires. */
  atOffsetMinutes?: number;
}

export interface CostModel {
  fixed?: number;
  /** Resource id -> cost per unit consumed. */
  perResource?: Record<string, number>;
}

export interface ActionEventTemplate {
  /** Stable suffix; the engine prefixes it to build the event id. */
  id: string;
  type: SimulationEventType;
  eventClass: EventClass;
  message: string;
  severity?: EventSeverity;
  /** Minutes after the decision time. */
  atOffsetMinutes: number;
  entityId?: string;
  resourceId?: string;
  facilityId?: string;
  routeId?: string;
  focusEntityId?: string;
  causedBy?: string;
}

/** What an ActionHandler receives. Deliberately excludes the scenario to keep
 *  `action -> scenario -> action` out of the module graph; a handler defined in
 *  a scenario module closes over whatever scenario data it needs. */
export interface ActionContext {
  /** Current simulation minute. */
  now: number;
  /** Minute at which this action's decision was taken. */
  decisionTime: number;
  /** now - decisionTime; negative before the decision fires. */
  sinceDecision: number;
  timestepMinutes: number;
  inputs: SimulationInputs;
  /** Deterministic RNG stream. Draw in a fixed order or replay breaks. */
  random: () => number;
  /** Queue an extra event. The engine assigns ids and ordering. */
  emit: (event: Omit<ActionEventTemplate, 'atOffsetMinutes'>) => void;
}

export interface TransitionResult {
  /** Non-fatal notes for the debug overlay. */
  notes?: string[];
}

export type ActionHandler = (
  state: SimulationState,
  ctx: ActionContext,
) => TransitionResult | void;

export interface ActionDefinition {
  id: string;
  label: string;
  /** Simulation minute at which the operator takes this decision. */
  decisionTimeMinutes: number;
  preconditions: Precondition[];
  resourceRequirements: ResourceRequirement[];
  /** Applied first, in declaration order. */
  transitions: StateTransition[];
  /** Applied after `transitions`, every step from the decision onward. */
  apply?: ActionHandler;
  emittedEvents: ActionEventTemplate[];
  costModel: CostModel;
}

/** Fixed cost of an action given the resources it consumes. */
export function actionCost(action: ActionDefinition): number {
  let total = action.costModel.fixed ?? 0;
  const perResource = action.costModel.perResource;
  if (perResource) {
    for (const requirement of action.resourceRequirements) {
      const rate = perResource[requirement.resourceId];
      if (rate == null) continue;
      const amount =
        typeof requirement.amount === 'boolean'
          ? requirement.amount
            ? 1
            : 0
          : requirement.amount;
      total += rate * amount;
    }
  }
  return total;
}

/**
 * Cascade processing — a stage of the EXISTING simulation loop, not a parallel
 * engine.
 *
 * Every timestep the simulator calls `processor.step(...)`. The processor:
 *
 *   1. checks each rule's trigger against real state / the step's events
 *   2. applies threshold-CROSSING semantics (fires on false -> true, not while true)
 *   3. honours per-rule delay (trigger at T, emit at T + delay)
 *   4. honours one-shot semantics (`once`, default true)
 *   5. applies the rule's STATE EFFECT and emits its event, with full provenance
 *   6. lets events a rule emits trigger further rules IN THE SAME STEP, bounded by
 *      MAX_DEPTH, MAX_EVENTS_PER_STEP and MAX_TOTAL_EVENTS
 *
 * Loop protection is structural: once-guards + stable rule ids + a hard depth
 * cap + a hard event-count cap. A cascade cannot hang the browser. When a cap is
 * hit the processor records a structured `CascadeFault` — visible to debugging,
 * never silent.
 */

import type {
  CascadeRule,
  CascadeTrigger,
  SimulationEvent,
  SimulationState,
} from '../domain';

export const CASCADE_LIMITS = {
  /** How many generations of rule-triggers-rule are followed within one step. */
  maxDepth: 8,
  /** Cascade events emitted in a single timestep before the processor stops. */
  maxEventsPerStep: 40,
  /** Cascade events emitted across the whole run before the processor stops. */
  maxTotalEvents: 500,
} as const;

export interface CascadeFault {
  kind: 'depth' | 'per-step' | 'total';
  ruleId: string;
  atMinutes: number;
  message: string;
}

export interface CascadeStepContext {
  now: number;
  /** The interval this step covers is (previous, now]. */
  previous: number;
  /** Events already emitted this step (scheduled events, action events, …). */
  stepEvents: readonly SimulationEvent[];
  emit: (event: SimulationEvent) => void;
}

const OPS: Record<string, (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '=': (a, b) => a === b,
};

function conditionMet(
  trigger: CascadeTrigger,
  state: SimulationState,
  ctx: CascadeStepContext,
  stepEvents: readonly SimulationEvent[],
): { met: boolean; because: string; causeEventId?: string } {
  // Optional extra flag gate.
  if (trigger.whenFlag != null) {
    const gate = state.flags[trigger.whenFlag];
    if (gate == null || gate === false || gate === 0) {
      return { met: false, because: '' };
    }
  }

  switch (trigger.kind) {
    case 'time': {
      const at = trigger.atMinutes ?? 0;
      const met = at > ctx.previous + 1e-9 && at <= ctx.now + 1e-9;
      return { met, because: `minute ${at} reached` };
    }
    case 'event': {
      const hit = stepEvents.find((e) => e.type === trigger.eventType);
      return hit
        ? { met: true, because: `event "${trigger.eventType}" occurred`, causeEventId: hit.id }
        : { met: false, because: '' };
    }
    case 'metric': {
      const value = state.metrics[trigger.metric as keyof typeof state.metrics];
      if (value == null || trigger.operator == null || trigger.threshold == null) {
        return { met: false, because: '' };
      }
      const met = OPS[trigger.operator](value, trigger.threshold);
      return {
        met,
        because: `${trigger.metric} ${trigger.operator} ${trigger.threshold} (at ${value.toFixed(1)})`,
      };
    }
    case 'state': {
      const raw = state.flags[trigger.flag ?? ''];
      const value = typeof raw === 'number' ? raw : raw === true ? 1 : 0;
      if (trigger.operator == null || trigger.threshold == null) {
        return { met: raw != null && raw !== false && raw !== 0, because: `flag "${trigger.flag}" set` };
      }
      return {
        met: OPS[trigger.operator](value, trigger.threshold),
        because: `flag ${trigger.flag} ${trigger.operator} ${trigger.threshold}`,
      };
    }
    case 'resource': {
      const resource = state.resources[trigger.resourceId ?? ''];
      if (!resource) return { met: false, because: '' };
      const met = resource.status === trigger.resourceStatus;
      return { met, because: `${resource.label} is ${trigger.resourceStatus}` };
    }
    default:
      return { met: false, because: '' };
  }
}

interface PendingEmission {
  rule: CascadeRule;
  emitAt: number;
  because: string;
  causeEventId?: string;
  depth: number;
}

export interface CascadeProcessor {
  step: (state: SimulationState, ctx: CascadeStepContext) => void;
  readonly faults: CascadeFault[];
  readonly firedRuleIds: readonly string[];
}

export function createCascadeProcessor(rules: readonly CascadeRule[]): CascadeProcessor {
  const faults: CascadeFault[] = [];
  const fired = new Set<string>();
  /** Last-observed truthiness of each rule's condition, for crossing semantics. */
  const armed = new Map<string, boolean>();
  const pending: PendingEmission[] = [];
  let totalEmitted = 0;

  function apply(
    rule: CascadeRule,
    state: SimulationState,
    now: number,
    because: string,
    causeEventId: string | undefined,
    depth: number,
    emit: (e: SimulationEvent) => void,
    perStepCount: { n: number },
  ): void {
    if (depth >= CASCADE_LIMITS.maxDepth) {
      recordFault('depth', rule.id, now);
      return;
    }
    if (totalEmitted >= CASCADE_LIMITS.maxTotalEvents) {
      recordFault('total', rule.id, now);
      return;
    }
    if (perStepCount.n >= CASCADE_LIMITS.maxEventsPerStep) {
      recordFault('per-step', rule.id, now);
      return;
    }

    /* --- state effect --- */
    const effect = rule.effect;
    if (effect) {
      if (effect.setFlags) {
        for (const key of Object.keys(effect.setFlags)) state.flags[key] = effect.setFlags[key];
      }
      for (const entityId of effect.breaksRefrigeration ?? []) {
        const entity = state.entities[entityId];
        if (entity) {
          entity.refrigerated = false;
          entity.status = 'refrigeration_failed';
        }
      }
      for (const routeId of effect.blocksRoutes ?? []) {
        state.flags[`route-blocked:${routeId}`] = now;
      }
      if (effect.adjustMetric) {
        const key = effect.adjustMetric.metric as keyof typeof state.metrics;
        const current = state.metrics[key] ?? 0;
        state.metrics[key] = current + effect.adjustMetric.delta;
      }
    }

    /* --- new event, with provenance --- */
    if (rule.emit) {
      const event: SimulationEvent = {
        id: `cascade-${rule.id}-${Math.round(now)}`,
        timestamp: now,
        type: rule.emit.type,
        eventClass: rule.emit.eventClass,
        entityId: rule.emit.entityId,
        routeId: rule.emit.routeId,
        resourceId: rule.emit.resourceId,
        message: rule.emit.message,
        severity: rule.emit.severity ?? 'warning',
        focusEntityId: rule.emit.focusEntityId ?? rule.emit.entityId,
        causedBy: causeEventId,
        cascade: {
          ruleId: rule.id,
          trigger: because,
          triggerKind: rule.trigger.kind,
          sourceId: rule.sourceId,
          affectedId: rule.affectedId,
          causeEventId,
          depth,
        },
      };
      emit(event);
      totalEmitted += 1;
      perStepCount.n += 1;
    }
  }

  function recordFault(kind: CascadeFault['kind'], ruleId: string, atMinutes: number): void {
    if (faults.some((f) => f.kind === kind && f.ruleId === ruleId)) return;
    faults.push({
      kind,
      ruleId,
      atMinutes,
      message:
        kind === 'depth'
          ? `Cascade depth limit (${CASCADE_LIMITS.maxDepth}) hit at rule "${ruleId}" — further generations suppressed`
          : kind === 'per-step'
            ? `Per-step cascade event limit (${CASCADE_LIMITS.maxEventsPerStep}) hit at minute ${atMinutes}`
            : `Total cascade event limit (${CASCADE_LIMITS.maxTotalEvents}) hit — cascade processing stopped`,
    });
  }

  function step(state: SimulationState, ctx: CascadeStepContext): void {
    const perStepCount = { n: 0 };
    // A mutable, growing view of this step's events so a rule can trigger on an
    // event another rule just emitted. `depthOf` maps event id -> cascade depth
    // (upstream, non-cascade events count as depth -1 so the first generation
    // lands at depth 0).
    const seen: SimulationEvent[] = [...ctx.stepEvents];
    const depthOf = new Map<string, number>();
    for (const e of seen) depthOf.set(e.id, e.cascade?.depth ?? -1);
    const emit = (e: SimulationEvent) => {
      seen.push(e);
      depthOf.set(e.id, e.cascade?.depth ?? 0);
      ctx.emit(e);
    };

    /* --- 1. release delayed emissions whose time has come --- */
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const p = pending[i];
      if (p.emitAt > ctx.now + 1e-9) continue;
      pending.splice(i, 1);
      apply(p.rule, state, ctx.now, p.because, p.causeEventId, p.depth, emit, perStepCount);
    }

    /* --- 2. evaluate triggers to a fixpoint. Each firing's depth comes from
       its cause event (metric/time/state/resource triggers -> depth 0), so a
       real N-deep chain is measured accurately and stopped at MAX_DEPTH. The
       outer cap is a structural backstop, never the primary guard — crossing
       semantics + one-shot guards already prevent A<->B oscillation. --- */
    const HARD_ITERATION_CAP = CASCADE_LIMITS.maxDepth * 4 + 4;
    for (let iteration = 0; iteration < HARD_ITERATION_CAP; iteration += 1) {
      let firedThisPass = 0;

      for (const rule of rules) {
        const oneShot = rule.once ?? true;
        if (oneShot && fired.has(rule.id)) continue;

        const { met, because, causeEventId } = conditionMet(rule.trigger, state, ctx, seen);
        const wasArmed = armed.get(rule.id) ?? false;
        armed.set(rule.id, met);

        // Crossing semantics: fire only on the false -> true transition.
        if (!met || wasArmed) continue;

        fired.add(rule.id);
        firedThisPass += 1;

        const causeDepth =
          causeEventId != null ? (depthOf.get(causeEventId) ?? -1) : -1;
        const depth = causeDepth + 1;

        const delay = rule.delayMinutes ?? 0;
        if (delay > 0) {
          pending.push({ rule, emitAt: ctx.now + delay, because, causeEventId, depth });
          continue;
        }
        apply(rule, state, ctx.now, because, causeEventId, depth, emit, perStepCount);
      }

      if (firedThisPass === 0) break;
      if (iteration === HARD_ITERATION_CAP - 1) {
        recordFault('depth', rules[0]?.id ?? 'unknown', ctx.now);
      }
    }
  }

  return {
    step,
    faults,
    get firedRuleIds() {
      return [...fired];
    },
  };
}

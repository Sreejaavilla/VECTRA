/**
 * Pure, view-layer selectors. No domain math — these only read and interpolate
 * the immutable `SimulationResult`. Everything here is a plain function so it
 * can be memoized at call sites and unit-tested in isolation.
 */

import {
  DECISION_TYPES,
  interpolatePosition,
  lerp,
  lerpVec,
  METRIC_KEYS,
  routePolyline as domainRoutePolyline,
  type EntityState,
  type EventClass,
  type MetricKey,
  type NarrativePhase,
  type ResourceState,
  type Route,
  type ScenarioConfig,
  type SimulationEvent,
  type SimulationResult,
  type SimulationStep,
  type StepMetrics,
  type Vec2,
} from './types';

/* --------------------------------------------------------------------------- *
 * Time / formatting
 * --------------------------------------------------------------------------- */

/** Simulation minutes -> "MM:SS"-style "HH:MM" clock string ("01:24"). */
export function formatSimulationTime(minutes: number): string {
  const clamped = Math.max(0, minutes);
  const whole = Math.floor(clamped);
  const hh = Math.floor(whole / 60);
  const mm = whole % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* --------------------------------------------------------------------------- *
 * Geometry — the primitives live in the domain so the engine and the view agree
 * on where a route's 40% mark is.
 * --------------------------------------------------------------------------- */

export { interpolatePosition };

/** Points that define a route's polyline (explicit waypoints or endpoint centres). */
export function routePolyline(route: Route, scenario: ScenarioConfig): Vec2[] {
  return domainRoutePolyline(route, scenario.facilities);
}

/** Point at `progress` along a route. */
export function getRoutePoint(route: Route, scenario: ScenarioConfig, progress: number): Vec2 {
  return interpolatePosition(routePolyline(route, scenario), progress);
}

/** Resolve an entity to an absolute map position. */
export function resolveEntityPosition(entity: EntityState, scenario: ScenarioConfig): Vec2 {
  if (entity.position) return entity.position;
  if (entity.routeId) {
    const route = scenario.routes.find((r) => r.id === entity.routeId);
    if (route) return getRoutePoint(route, scenario, entity.progress);
  }
  return { x: 0, y: 0 };
}

/** Heading in degrees for an entity travelling its route (for glyph rotation). */
export function resolveEntityHeading(entity: EntityState, scenario: ScenarioConfig): number {
  if (!entity.routeId) return 0;
  const route = scenario.routes.find((r) => r.id === entity.routeId);
  if (!route) return 0;
  const ahead = getRoutePoint(route, scenario, Math.min(1, entity.progress + 0.02));
  const behind = getRoutePoint(route, scenario, Math.max(0, entity.progress - 0.02));
  return (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI;
}

/* --------------------------------------------------------------------------- *
 * Events
 * --------------------------------------------------------------------------- */

export function classifyEvent(event: SimulationEvent): EventClass {
  return event.eventClass ?? (DECISION_TYPES.includes(event.type) ? 'decision' : 'system');
}

export function getEventsUpTo(result: SimulationResult, t: number): SimulationEvent[] {
  return result.events.filter((e) => e.timestamp <= t + 1e-6);
}

/** Events within [t - window, t]. */
export function getActiveEvents(
  result: SimulationResult,
  t: number,
  window: number,
): SimulationEvent[] {
  return result.events.filter((e) => e.timestamp <= t + 1e-6 && e.timestamp >= t - window);
}

/* --------------------------------------------------------------------------- *
 * Step lookup + interpolation
 * --------------------------------------------------------------------------- */

function bracketSteps(steps: SimulationStep[], t: number): [SimulationStep, SimulationStep, number] {
  if (steps.length === 0) throw new Error('SimulationResult has no steps');
  if (t <= steps[0].timestamp) return [steps[0], steps[0], 0];
  const last = steps[steps.length - 1];
  if (t >= last.timestamp) return [last, last, 0];

  for (let i = 1; i < steps.length; i += 1) {
    if (steps[i].timestamp >= t) {
      const prev = steps[i - 1];
      const next = steps[i];
      const span = next.timestamp - prev.timestamp;
      const f = span === 0 ? 0 : (t - prev.timestamp) / span;
      return [prev, next, f];
    }
  }
  return [last, last, 0];
}

function interpolateEntities(
  prev: EntityState[],
  next: EntityState[],
  f: number,
): EntityState[] {
  return prev.map((entity) => {
    const to = next.find((e) => e.id === entity.id);
    if (!to || to.routeId !== entity.routeId) return { ...entity };
    return {
      ...entity,
      progress: lerp(entity.progress, to.progress, f),
      position:
        entity.position && to.position
          ? lerpVec(entity.position, to.position, f)
          : entity.position,
      // Status/active flip at the "next" step so transitions land on keyframes.
      status: f > 0.999 ? to.status : entity.status,
      active: entity.active || to.active,
    };
  });
}

export interface StateAtTime {
  step: SimulationStep;
  nextStep: SimulationStep;
  entities: EntityState[];
  resources: ResourceState[];
  metrics: StepMetrics;
  narrativePhase: NarrativePhase;
  focus: FocusTarget | null;
}

export function getStateAtTime(result: SimulationResult, t: number): StateAtTime {
  const [prev, next, f] = bracketSteps(result.steps, t);
  const entities = interpolateEntities(prev.entities, next.entities, f);
  const metrics: StepMetrics = {};
  for (const key of METRIC_KEYS) {
    const a = prev.metrics[key];
    const b = next.metrics[key];
    if (a == null && b == null) continue;
    if (a == null) metrics[key] = b;
    else if (b == null) metrics[key] = a;
    else metrics[key] = lerp(a, b, f);
  }
  return {
    step: prev,
    nextStep: next,
    entities,
    resources: prev.resources,
    metrics,
    narrativePhase: getNarrativePhase(result, t),
    focus: getFocusTarget(result, t),
  };
}

/* --------------------------------------------------------------------------- *
 * Narrative phase — a summary caption, NOT authoritative system state.
 * --------------------------------------------------------------------------- */

export function getNarrativePhase(result: SimulationResult, t: number): NarrativePhase {
  const seen = getEventsUpTo(result, t);
  const has = (type: string) => seen.some((e) => e.type === type);

  if (has('DELIVERY')) return 'DELIVERY';
  if (has('RECOVERY') || has('INTERCEPTION') || has('STORAGE_TRANSFER')) return 'RECOVERY';
  if (seen.some((e) => classifyEvent(e) === 'decision')) return 'INTERVENTION';
  if (has('THRESHOLD_CROSSED')) return 'DETERIORATING';
  if (has('FAILURE')) return 'FAILURE';
  return 'NORMAL';
}

/* --------------------------------------------------------------------------- *
 * Focus target — drives the map's "direct the judge's attention" emphasis.
 * --------------------------------------------------------------------------- */

export interface FocusTarget {
  entityId: string;
  reason: string;
  /** 0..1 — full at the event, decays to 0 over FOCUS_WINDOW minutes. */
  intensity: number;
}

export const FOCUS_WINDOW_MINUTES = 12;

export function getFocusTarget(result: SimulationResult, t: number): FocusTarget | null {
  let best: FocusTarget | null = null;
  for (const event of result.events) {
    if (event.timestamp > t + 1e-6) break;
    const entityId = event.focusEntityId ?? event.entityId;
    if (!entityId) continue;
    const age = t - event.timestamp;
    if (age > FOCUS_WINDOW_MINUTES) continue;
    const intensity = 1 - age / FOCUS_WINDOW_MINUTES;
    best = { entityId, reason: event.message, intensity };
  }
  return best;
}

/* --------------------------------------------------------------------------- *
 * Metric series (charts + comparison)
 * --------------------------------------------------------------------------- */

export interface MetricPoint {
  t: number;
  value: number;
}

export function getMetricSeries(result: SimulationResult, key: MetricKey): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const step of result.steps) {
    const value = step.metrics[key];
    if (value != null) out.push({ t: step.timestamp, value });
  }
  return out;
}

/* --------------------------------------------------------------------------- *
 * Entity visual descriptor (icon / shape / label — never colour alone)
 * --------------------------------------------------------------------------- */

export interface EntityVisual {
  glyph: 'truck' | 'support' | 'dot';
  badge: 'none' | 'warning' | 'ok';
  statusLabel: string;
  severity: 'normal' | 'warning' | 'critical' | 'ok';
}

export function getEntityVisualState(entity: EntityState): EntityVisual {
  const glyph: EntityVisual['glyph'] =
    entity.kind === 'shipment_vehicle' ? 'truck' : entity.kind === 'support_vehicle' ? 'support' : 'dot';

  switch (entity.status) {
    case 'refrigeration_failed':
      return { glyph, badge: 'warning', statusLabel: 'Refrigeration failed', severity: 'critical' };
    case 'recovering':
      return { glyph, badge: 'ok', statusLabel: 'Recovering', severity: 'ok' };
    case 'delivering':
      return { glyph, badge: 'none', statusLabel: 'Delivering', severity: 'normal' };
    case 'delivered':
      return { glyph, badge: 'ok', statusLabel: 'Delivered', severity: 'ok' };
    case 'dispatched':
      return { glyph, badge: 'none', statusLabel: 'Dispatched', severity: 'warning' };
    case 'escorting':
      return { glyph, badge: 'ok', statusLabel: 'Escorting', severity: 'ok' };
    case 'idle':
      return { glyph, badge: 'none', statusLabel: 'Standby', severity: 'normal' };
    default:
      return { glyph, badge: 'none', statusLabel: 'En route', severity: 'normal' };
  }
}

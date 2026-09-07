/**
 * The operational map. Pure projection of pre-derived simulation state onto an
 * abstract SVG network (viewBox 0 0 100 60). Contains its SVG primitives
 * (routes, facility nodes, entity markers, event markers) as local components —
 * they share the same coordinate space and have no independent responsibility.
 */

import { useMemo } from 'react';
import type {
  EntityState,
  Facility,
  Route,
  ScenarioConfig,
  SimulationEvent,
} from '../../simulation/types';
import {
  classifyEvent,
  getEntityVisualState,
  resolveEntityHeading,
  resolveEntityPosition,
  routePolyline,
  type FocusTarget,
} from '../../simulation/selectors';
import styles from './OperationalMap.module.css';

interface OperationalMapProps {
  scenario: ScenarioConfig;
  entities: EntityState[];
  activeRouteIds: string[];
  completedRouteIds: string[];
  events: SimulationEvent[];
  focus: FocusTarget | null;
  selectedEntityId: string | null;
  onSelectEntity: (id: string | null) => void;
}

export function OperationalMap({
  scenario,
  entities,
  activeRouteIds,
  completedRouteIds,
  events,
  focus,
  selectedEntityId,
  onSelectEntity,
}: OperationalMapProps) {
  const focusedId = selectedEntityId ?? focus?.entityId ?? null;
  const dimOthers = focusedId != null;

  const routePaths = useMemo(
    () =>
      scenario.routes.map((route) => ({
        route,
        d: toPath(routePolyline(route, scenario)),
      })),
    [scenario],
  );

  return (
    <svg
      className={styles.map}
      viewBox="-3 -6 106 72"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Operational map of the cold-chain network"
      onClick={() => onSelectEntity(null)}
    >
      <defs>
        <marker id="chevron" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0 0 L8 5 L0 10" fill="none" stroke="currentColor" strokeWidth="2" />
        </marker>
      </defs>

      {/* Routes */}
      <g>
        {routePaths.map(({ route, d }) => (
          <RoutePath
            key={route.id}
            route={route}
            d={d}
            state={
              completedRouteIds.includes(route.id)
                ? 'completed'
                : activeRouteIds.includes(route.id)
                  ? 'active'
                  : route.blocked
                    ? 'blocked'
                    : 'planned'
            }
          />
        ))}
      </g>

      {/* Facilities */}
      <g>
        {scenario.facilities.map((facility) => (
          <FacilityNode key={facility.id} facility={facility} dim={dimOthers} />
        ))}
      </g>

      {/* Entities */}
      <g>
        {entities
          .filter((e) => e.active)
          .map((entity) => (
            <EntityMarker
              key={entity.id}
              entity={entity}
              scenario={scenario}
              focused={entity.id === focusedId}
              dim={dimOthers && entity.id !== focusedId}
              onSelect={(id) => onSelectEntity(id)}
            />
          ))}
      </g>

      {/* Event markers */}
      <g>
        {events.map((event) => (
          <EventMarker key={event.id} event={event} scenario={scenario} entities={entities} />
        ))}
      </g>
    </svg>
  );
}

/* --------------------------------------------------------------------------- */

function toPath(points: { x: number; y: number }[]): string {
  if (points.length === 0) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
}

type RouteVisualState = 'planned' | 'active' | 'completed' | 'blocked';

function RoutePath({ route, d, state }: { route: Route; d: string; state: RouteVisualState }) {
  const kindClass =
    route.kind === 'emergency'
      ? styles.routeEmergency
      : route.kind === 'reroute'
        ? styles.routeReroute
        : styles.routePrimary;

  return (
    <g className={`${styles.route} ${kindClass} ${styles[`route_${state}`]}`}>
      <path className={styles.routeBase} d={d} />
      {state === 'active' && <path className={styles.routeFlow} d={d} markerMid="url(#chevron)" />}
      {state === 'blocked' && <path className={styles.routeBlocked} d={d} />}
    </g>
  );
}

function FacilityNode({ facility, dim }: { facility: Facility; dim: boolean }) {
  const { x, y } = facility.position;
  const used = facility.capacity ? Math.round((facility.capacity.used / facility.capacity.capacity) * 100) : null;

  return (
    <g className={`${styles.facility} ${dim ? styles.dim : ''}`} transform={`translate(${x} ${y})`}>
      {facility.kind === 'storage' ? (
        <rect x={-2.6} y={-2.6} width={5.2} height={5.2} className={styles.facilityShape} rx={0.6} />
      ) : facility.kind === 'hub' ? (
        <circle r={2.8} className={styles.facilityShape} />
      ) : (
        <path d="M0 -3 L2.7 1.6 L-2.7 1.6 Z" className={styles.facilityShape} />
      )}
      <text className={styles.facilityLabel} y={-4}>
        {facility.label}
      </text>
      {used != null && (
        <text className={styles.facilityMeta} y={6}>
          {facility.capacity!.used.toLocaleString()} / {facility.capacity!.capacity.toLocaleString()}
        </text>
      )}
    </g>
  );
}

function EntityMarker({
  entity,
  scenario,
  focused,
  dim,
  onSelect,
}: {
  entity: EntityState;
  scenario: ScenarioConfig;
  focused: boolean;
  dim: boolean;
  onSelect: (id: string) => void;
}) {
  const pos = resolveEntityPosition(entity, scenario);
  const heading = resolveEntityHeading(entity, scenario);
  const visual = getEntityVisualState(entity);

  return (
    <g
      className={`${styles.entity} ${dim ? styles.dim : ''} ${focused ? styles.entityFocused : ''} ${styles[`sev_${visual.severity}`]}`}
      transform={`translate(${pos.x} ${pos.y})`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(entity.id);
      }}
      role="button"
      aria-label={`${entity.label}: ${visual.statusLabel}`}
      tabIndex={0}
    >
      {focused && <circle className={styles.entityHalo} r={5.2} />}
      <g transform={`rotate(${heading})`}>
        {visual.glyph === 'truck' ? (
          <rect x={-2.4} y={-1.6} width={4.8} height={3.2} rx={0.5} className={styles.entityShape} />
        ) : (
          <circle r={1.9} className={styles.entityShape} />
        )}
      </g>
      {visual.badge === 'warning' && (
        <text className={styles.entityBadge} y={-3.4} textAnchor="middle">
          !
        </text>
      )}
      <text className={styles.entityLabel} y={4.4} textAnchor="middle">
        {visual.statusLabel}
      </text>
    </g>
  );
}

function EventMarker({
  event,
  scenario,
  entities,
}: {
  event: SimulationEvent;
  scenario: ScenarioConfig;
  entities: EntityState[];
}) {
  let anchor: { x: number; y: number } | null = null;
  if (event.facilityId) {
    anchor = scenario.facilities.find((f) => f.id === event.facilityId)?.position ?? null;
  }
  if (!anchor && event.entityId) {
    const ent = entities.find((e) => e.id === event.entityId);
    if (ent) anchor = resolveEntityPosition(ent, scenario);
  }
  if (!anchor) return null;

  const cls = classifyEvent(event);
  const sevClass =
    event.severity === 'critical'
      ? styles.evCrit
      : event.severity === 'warning'
        ? styles.evWarn
        : styles.evInfo;

  return (
    <g className={`${styles.eventMarker} ${sevClass}`} transform={`translate(${anchor.x} ${anchor.y})`}>
      {cls === 'decision' ? (
        <path d="M0 -3.4 L3.4 0 L0 3.4 L-3.4 0 Z" className={styles.eventShape} />
      ) : (
        <circle r={2.6} className={styles.eventShape} />
      )}
      <circle className={styles.eventPulse} r={2.6} />
    </g>
  );
}

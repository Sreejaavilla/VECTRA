/**
 * Spatial primitives: facilities (nodes), routes (edges) and entities (things
 * that move along edges).
 *
 * Identity rule: everything is referenced by a stable string id — never by
 * array index, screen position, timestamp or object reference.
 *
 * Position rule: `routeId + progress` is the authoritative location. `position`
 * exists only as an explicit override for entities staged off-route. The view
 * derives screen coordinates; it never competes as a source of truth.
 */

/** Abstract map coordinate. The operational map uses a 0..100 (x) by 0..60 (y) space. */
export interface Vec2 {
  x: number;
  y: number;
}

/** Optional utilization state the map renders when present. */
export interface Capacity {
  capacity: number;
  used: number;
  unit?: string;
}

export type FacilityKind = 'hub' | 'destination' | 'storage' | (string & {});

export interface Facility {
  id: string;
  kind: FacilityKind;
  label: string;
  position: Vec2;
  /** Cold-storage used/total, hospital received/demand, etc. */
  capacity?: Capacity;
  /** Priority, ETA and other display-only annotations. */
  meta?: Record<string, string | number>;
}

export type RouteKind = 'primary' | 'emergency' | 'reroute' | (string & {});

export interface Route {
  id: string;
  from: string;
  to: string;
  /** Optional polyline; a straight line between endpoints is used when absent. */
  waypoints?: Vec2[];
  kind?: RouteKind;
  capacity?: Capacity;
  blocked?: boolean;
  /** Minutes to traverse the full route at nominal speed. */
  travelTimeMinutes?: number;
  /**
   * Route an entity continues onto when it arrives here still carrying payload.
   * Lets a multi-destination shipment be expressed as chained legs rather than
   * as bespoke logic in every action.
   */
  continuesTo?: string;
}

export type EntityKind = 'shipment_vehicle' | 'support_vehicle' | (string & {});

/** Render-facing entity snapshot. Derived from the authoritative runtime state. */
export interface EntityState {
  id: string;
  kind: EntityKind;
  label: string;
  /** Route the entity is currently travelling. */
  routeId: string | null;
  /** 0..1 along `routeId`. */
  progress: number;
  /** Explicit position override (e.g. staged off-route). Wins over route+progress. */
  position?: Vec2;
  /**
   * e.g. 'en_route' | 'refrigeration_failed' | 'intercepted' | 'delivering'
   * | 'delivered' | 'idle' | 'dispatched'
   */
  status: string;
  /** Whether the entity is drawn on the map at all. */
  active: boolean;
}

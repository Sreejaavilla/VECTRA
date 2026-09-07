/**
 * Polyline geometry shared by the engine (route-switch continuity, arrival
 * detection) and the view (glyph placement, heading).
 *
 * Both layers must agree on where a route's 40% mark is, so this lives in the
 * domain rather than being duplicated on either side.
 */

import type { Route, Vec2 } from './entity';

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

export function lerpVec(a: Vec2, b: Vec2, f: number): Vec2 {
  return { x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f) };
}

/** Resolve a point at `progress` (0..1) along a polyline, by arc length. */
export function interpolatePosition(points: Vec2[], progress: number): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0] };
  const f = Math.max(0, Math.min(1, progress));

  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const len = Math.hypot(dx, dy);
    lengths.push(len);
    total += len;
  }
  if (total === 0) return { ...points[0] };

  let target = f * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const segF = lengths[i] === 0 ? 0 : target / lengths[i];
      return lerpVec(points[i], points[i + 1], segF);
    }
    target -= lengths[i];
  }
  return { ...points[points.length - 1] };
}

/** Points that define a route's polyline (explicit waypoints or endpoint centres). */
export function routePolyline(
  route: Route,
  facilities: readonly { id: string; position: Vec2 }[],
): Vec2[] {
  if (route.waypoints && route.waypoints.length >= 2) return route.waypoints;
  const from = facilities.find((fac) => fac.id === route.from);
  const to = facilities.find((fac) => fac.id === route.to);
  if (!from || !to) return [];
  return [from.position, to.position];
}

/**
 * Progress along `points` whose world position is nearest to `target`.
 *
 * Used when an entity switches routes: progress is NOT carried across (the two
 * routes have different lengths and shapes, so the number means nothing on the
 * new route) and it is NOT reset to zero (that would teleport the entity back
 * to the depot). Instead the entity keeps its world position and we solve for
 * the progress that reproduces it.
 */
export function nearestProgress(points: Vec2[], target: Vec2, samples = 200): number {
  if (points.length < 2) return 0;
  let bestProgress = 0;
  let bestDistance = Infinity;
  for (let i = 0; i <= samples; i += 1) {
    const progress = i / samples;
    const point = interpolatePosition(points, progress);
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestProgress = progress;
    }
  }
  return bestProgress;
}

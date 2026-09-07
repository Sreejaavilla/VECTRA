/**
 * Declarative state transitions — the common half of the action vocabulary.
 * Anything a `target + op + value` triple expresses cleanly lives here;
 * anything it would only express awkwardly belongs in an ActionHandler.
 */

import type {
  Facility,
  Route,
  SimulationState,
  StateTransition,
} from '../domain';
import { interpolatePosition, nearestProgress, routePolyline } from '../domain';

export interface TransitionEnv {
  routes: readonly Route[];
  facilities: readonly Facility[];
}

/**
 * Move an entity onto a different route WITHOUT teleporting it.
 *
 * Progress is not carried across — the same 0.44 means a different place on a
 * route of different length and shape — and it is not reset to zero, which
 * would snap the entity back to the depot. The entity keeps its world position
 * and we solve for the progress on the new route that reproduces it.
 */
export function switchRoute(
  state: SimulationState,
  entityId: string,
  routeId: string,
  env: TransitionEnv,
): void {
  const entity = state.entities[entityId];
  if (!entity) return;
  const nextRoute = env.routes.find((r) => r.id === routeId);
  if (!nextRoute) return;

  const nextPolyline = routePolyline(nextRoute, env.facilities);
  const currentRoute = entity.routeId
    ? env.routes.find((r) => r.id === entity.routeId)
    : undefined;

  if (!currentRoute || nextPolyline.length < 2) {
    entity.routeId = routeId;
    entity.progress = 0;
    return;
  }

  const currentPosition = interpolatePosition(
    routePolyline(currentRoute, env.facilities),
    entity.progress,
  );
  entity.routeId = routeId;
  entity.progress = nearestProgress(nextPolyline, currentPosition);
}

export function applyTransition(
  state: SimulationState,
  transition: StateTransition,
  env: TransitionEnv,
): void {
  switch (transition.target) {
    case 'entity': {
      const entity = state.entities[transition.id];
      if (!entity) return;
      if (transition.op === 'route-switch' && typeof transition.value === 'string') {
        switchRoute(state, transition.id, transition.value, env);
      } else if (transition.op === 'set-status' && typeof transition.value === 'string') {
        entity.status = transition.value;
      } else if (transition.op === 'set-active') {
        entity.active = transition.value !== false;
      }
      return;
    }
    case 'resource': {
      const resource = state.resources[transition.id];
      if (!resource) return;
      if (transition.op === 'allocate') {
        const amount =
          typeof transition.value === 'number'
            ? transition.value
            : resource.kind === 'boolean'
              ? 1
              : 0;
        resource.quantity = Math.max(0, resource.quantity - amount);
        resource.status = resource.quantity <= 0 ? 'depleted' : 'allocated';
        if (resource.kind === 'boolean') resource.status = 'allocated';
        const unitCost = resource.unitCost ?? 0;
        const key = `spend:${resource.id}`;
        state.flags[key] = Number(state.flags[key] ?? 0) + unitCost * amount;
      } else if (transition.op === 'release') {
        const amount = typeof transition.value === 'number' ? transition.value : 0;
        resource.quantity += amount;
        resource.status = 'available';
      } else if (transition.op === 'add' && typeof transition.value === 'number') {
        resource.quantity += transition.value;
        if (resource.quantity <= 0) resource.status = 'depleted';
      }
      return;
    }
    case 'facility': {
      const facility = state.facilities[transition.id];
      if (!facility) return;
      if (transition.op === 'set-status' && typeof transition.value === 'string') {
        facility.status = transition.value;
      } else if (transition.op === 'add' && typeof transition.value === 'number') {
        facility.received += transition.value;
        if (facility.capacity) facility.capacity.used += transition.value;
      }
      return;
    }
    case 'flag': {
      if (transition.op === 'set-flag' && transition.value !== undefined) {
        state.flags[transition.id] = transition.value;
      } else if (transition.op === 'add' && typeof transition.value === 'number') {
        state.flags[transition.id] = Number(state.flags[transition.id] ?? 0) + transition.value;
      }
      return;
    }
    default:
      return;
  }
}

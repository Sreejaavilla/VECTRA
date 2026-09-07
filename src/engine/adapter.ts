/**
 * Shapes engine output into the render-facing contract.
 *
 * The authoritative state is id-keyed maps of runtime records; the view wants
 * arrays of flat snapshots. This is the one place that conversion happens, and
 * it only ever reads — it never computes a domain metric.
 */

import type {
  EntityState,
  ResourceDefinition,
  ResourceState,
  ScenarioConfig,
  SimulationState,
} from '../domain';
import type { SimulationStep } from '../simulation/types';
import type { TrajectoryFrame } from './simulator';

function formatDetail(
  definition: ResourceDefinition | undefined,
  runtime: SimulationState['resources'][string],
): string {
  const unit = runtime.unit ?? '';
  switch (definition?.detailFormat ?? (runtime.kind === 'boolean' ? 'availability' : 'count')) {
    case 'currency-lakh': {
      const total = runtime.capacity ?? runtime.quantity;
      return `₹${runtime.quantity.toFixed(1)}L of ₹${total.toFixed(1)}L remaining`;
    }
    case 'availability':
      return runtime.status === 'allocated'
        ? 'Deployed'
        : runtime.quantity > 0
          ? 'Available'
          : 'Not available for this run';
    case 'count':
    default: {
      if (runtime.capacity != null) {
        const used = Math.max(0, runtime.capacity - runtime.quantity);
        return `${used.toLocaleString()} / ${runtime.capacity.toLocaleString()} ${unit} used`;
      }
      return `${runtime.quantity.toLocaleString()} ${unit}`.trim();
    }
  }
}

export function toEntityStates(state: SimulationState): EntityState[] {
  return Object.keys(state.entities)
    .sort()
    .map((key) => {
      const entity = state.entities[key];
      return {
        id: entity.id,
        kind: entity.kind,
        label: entity.label,
        routeId: entity.routeId,
        progress: entity.progress,
        status: entity.status,
        active: entity.active,
      };
    });
}

export function toResourceStates(
  scenario: ScenarioConfig,
  state: SimulationState,
): ResourceState[] {
  return Object.keys(state.resources)
    .sort()
    .map((key) => {
      const runtime = state.resources[key];
      const definition = scenario.resources.find((r) => r.id === runtime.id);
      return {
        id: runtime.id,
        label: runtime.label,
        status: runtime.status,
        detail: formatDetail(definition, runtime),
      };
    });
}

export function framesToSteps(
  scenario: ScenarioConfig,
  frames: readonly TrajectoryFrame[],
): SimulationStep[] {
  return frames.map((frame) =>
    Object.freeze({
      timestamp: frame.state.timestamp,
      entities: toEntityStates(frame.state),
      resources: toResourceStates(scenario, frame.state),
      metrics: { ...frame.state.metrics },
      events: frame.events,
    }),
  );
}

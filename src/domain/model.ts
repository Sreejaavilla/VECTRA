/**
 * Step models are the domain physics plugged into the generic loop. The engine
 * knows the loop; it does not know what a temperature is.
 *
 * Models run once per timestep, in declared order, each reading the state the
 * previous one produced — temperature, then exposure, then viability.
 */

import type { SimulationInputs } from './inputs';
import type { SimulationState } from './state';

export interface StepModelContext {
  /** Current simulation minute. */
  now: number;
  /** Minutes elapsed since the previous step (0 on the first step). */
  dt: number;
  inputs: SimulationInputs;
  /** Deterministic RNG stream. Draw in a fixed order or replay breaks. */
  random: () => number;
}

export interface StepModel {
  id: string;
  /** Writes this model's contribution into `state.metrics` / `state.exposure`. */
  step: (state: SimulationState, ctx: StepModelContext) => void;
}

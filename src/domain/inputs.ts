/**
 * What the operator configures before a run. Kept in its own module so both
 * actions and scenarios can reference it without an import cycle.
 */

export interface SimulationInputs {
  /** Resource id -> starting availability/quantity override. */
  resources: Record<string, number | boolean>;
  /** Constraint id -> threshold override. */
  constraints: Record<string, number | boolean | string>;
  /** Objective id -> weight. Convention: sums to 1. */
  priorities: Record<string, number>;
}

export interface SimulationOptions {
  /**
   * Explicit seed. When omitted the engine derives one deterministically from
   * scenario + strategy + inputs + engine version, so ordinary runs are
   * reproducible without the caller tracking a seed. Supplying one lets a
   * specific run be replayed exactly, and is what robustness sweeps will vary.
   */
  seed?: number;
  runNumber?: number;
}

export const EMPTY_INPUTS: SimulationInputs = {
  resources: {},
  constraints: {},
  priorities: {},
};

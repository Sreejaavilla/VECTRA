/**
 * Sensitivity analysis output.
 *
 * Two questions, deliberately separated:
 *
 *   "What is this decision most sensitive to?"  -> `drivers`, a local influence
 *      ranking from small perturbations around the current operating point.
 *
 *   "What would change the decision?"           -> `flips`, the nearest value of
 *      each input at which the recommendation actually becomes a different
 *      strategy.
 *
 * The second is the more useful answer and the harder one to fake, so it is a
 * first-class part of the report rather than something inferred from bar
 * heights. Influence of zero is a real finding — it means that input is not
 * binding here, not that it does not matter in principle.
 */

/** Ranked influence, normalized to sum to 1. Drives the bar chart. */
export interface SensitivityDriver {
  label: string;
  weight: number;
  /** Which input this driver came from, when it came from a real sweep. */
  inputId?: string;
}

export interface SensitivityProbeSample {
  value: number | boolean;
  /** Best achievable score under this perturbation. */
  winningScore: number;
  /** null when nothing is feasible at this value. */
  recommendedStrategyId: string | null;
}

export interface SensitivityFlip {
  /** The nearest value to the baseline at which the recommendation changes. */
  value: number | boolean;
  from: string;
  /** null when the change is "nothing is feasible any more". */
  to: string | null;
  toLabel: string;
  direction: 'below' | 'above' | 'toggle';
}

export interface SensitivityProbe {
  inputId: string;
  label: string;
  kind: 'resource' | 'priority';
  baselineValue: number | boolean;
  samples: SensitivityProbeSample[];
  /** Mean |Δ best-achievable score| over the local neighbours. */
  influence: number;
  flip?: SensitivityFlip;
}

export interface SensitivityReport {
  baselineStrategyId: string | null;
  baselineLabel: string;
  baselineScore: number;
  /** Ranked, normalized. Empty when nothing moved the outcome at all. */
  drivers: SensitivityDriver[];
  probes: SensitivityProbe[];
  /** Probes whose perturbation actually changed the recommendation. */
  flips: SensitivityFlip[];
  /** How many full scenario evaluations this cost. */
  evaluations: number;
}

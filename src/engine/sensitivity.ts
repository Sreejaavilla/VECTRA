/**
 * Sensitivity analysis by controlled perturbation.
 *
 * For each input we hold everything else fixed, vary that one input, re-run the
 * WHOLE decision (feasibility, simulation, scoring, recommendation) and observe
 * what moved. Nothing here estimates or interpolates an outcome — every number
 * in the report came out of a real evaluation.
 *
 * Two products, and the second is the valuable one:
 *
 *   drivers — local influence: mean |Δ best-achievable score| over a small
 *             perturbation either side of the current value. Answers "what is
 *             this decision most sensitive to, here?"
 *
 *   flips   — the nearest value at which the recommendation becomes a different
 *             strategy. Answers "what would change the decision?", which is the
 *             question an operator actually has.
 *
 * An influence of zero is a real finding, not a gap: it means that input is not
 * binding at this operating point. Budget does not matter at ₹8L when the most
 * expensive action costs ₹3.4L, and the report should say so rather than
 * manufacture a bar.
 */

import type {
  ResourceDefinition,
  ScenarioConfig,
  SensitivityDriver,
  SensitivityFlip,
  SensitivityProbe,
  SensitivityProbeSample,
  SensitivityReport,
  SimulationInputs,
} from '../domain';
import { initialQuantity, normalizeWeights } from '../domain';
import { evaluateScenario } from './candidateEvaluator';
import type { EngineResult } from './errors';
import { validateInputs, validateScenario } from './feasibility';

export interface SensitivityOptions {
  /** Fractional perturbation used for the local influence measure. */
  delta?: number;
  /** Fractions of the baseline swept when hunting for a decision flip. */
  sweepFractions?: number[];
  /** Absolute perturbation applied to an objective weight. */
  weightDelta?: number;
}

const DEFAULTS = {
  delta: 0.25,
  sweepFractions: [0, 0.25, 0.5, 0.75, 1.25, 1.5],
  weightDelta: 0.15,
};

interface Outcome {
  strategyId: string | null;
  score: number;
}

/* --------------------------------------------------------------------------- *
 * Input construction
 * --------------------------------------------------------------------------- */

function baselineResourceValue(
  definition: ResourceDefinition,
  inputs: SimulationInputs,
): number | boolean {
  const override = inputs.resources[definition.id];
  if (override !== undefined) return override;
  return definition.kind === 'boolean'
    ? initialQuantity(definition) > 0
    : initialQuantity(definition);
}

function withResource(
  inputs: SimulationInputs,
  resourceId: string,
  value: number | boolean,
): SimulationInputs {
  return {
    ...inputs,
    resources: { ...inputs.resources, [resourceId]: value },
  };
}

/**
 * Move one objective's weight and absorb the change across the others in
 * proportion, so the weights still sum to 1 — otherwise the engine rejects the
 * inputs and we would be measuring a validation error, not a sensitivity.
 */
function withPriority(
  inputs: SimulationInputs,
  scenario: ScenarioConfig,
  objectiveId: string,
  value: number,
): SimulationInputs {
  const current: Record<string, number> = {};
  for (const objective of scenario.objectives) {
    current[objective.id] =
      inputs.priorities[objective.id] ?? objective.weight;
  }
  const target = Math.max(0, Math.min(1, value));
  const others = Object.keys(current).filter((id) => id !== objectiveId);
  const othersTotal = others.reduce((sum, id) => sum + current[id], 0);

  const next: Record<string, number> = { [objectiveId]: target };
  for (const id of others) {
    next[id] =
      othersTotal === 0
        ? (1 - target) / Math.max(1, others.length)
        : (1 - target) * (current[id] / othersTotal);
  }
  return { ...inputs, priorities: normalizeWeights(next) };
}

/* --------------------------------------------------------------------------- *
 * Probing
 * --------------------------------------------------------------------------- */

export function analyzeSensitivity(
  scenario: ScenarioConfig,
  inputs: SimulationInputs,
  options: SensitivityOptions = {},
): EngineResult<SensitivityReport> {
  const scenarioError = validateScenario(scenario);
  if (scenarioError) return { ok: false, error: scenarioError };
  const inputError = validateInputs(scenario, inputs);
  if (inputError) return { ok: false, error: inputError };

  const delta = options.delta ?? DEFAULTS.delta;
  const sweepFractions = options.sweepFractions ?? DEFAULTS.sweepFractions;
  const weightDelta = options.weightDelta ?? DEFAULTS.weightDelta;

  let evaluations = 0;
  const evaluateAt = (candidate: SimulationInputs): Outcome => {
    evaluations += 1;
    const outcome = evaluateScenario(scenario, candidate);
    if (!outcome.ok || !outcome.value.recommendation) {
      return { strategyId: null, score: 0 };
    }
    return {
      strategyId: outcome.value.recommendation.strategyId,
      score: outcome.value.recommendation.score,
    };
  };

  const baseline = evaluateAt(inputs);
  const labelFor = (id: string | null) =>
    scenario.actions.find((a) => a.id === id)?.label ?? 'no feasible strategy';

  const probes: SensitivityProbe[] = [];

  /* --- resources --- */
  for (const definition of scenario.resources) {
    const baselineValue = baselineResourceValue(definition, inputs);

    if (typeof baselineValue === 'boolean') {
      const flipped = !baselineValue;
      const outcome = evaluateAt(withResource(inputs, definition.id, flipped));
      const samples: SensitivityProbeSample[] = [
        { value: flipped, winningScore: outcome.score, recommendedStrategyId: outcome.strategyId },
      ];
      probes.push({
        inputId: definition.id,
        label: definition.label,
        kind: 'resource',
        baselineValue,
        samples,
        influence: Math.abs(outcome.score - baseline.score),
        flip:
          outcome.strategyId === baseline.strategyId
            ? undefined
            : {
                value: flipped,
                from: baseline.strategyId ?? 'none',
                to: outcome.strategyId,
                toLabel: labelFor(outcome.strategyId),
                direction: 'toggle',
              },
      });
      continue;
    }

    const values = uniqueSorted([
      ...sweepFractions.map((f) => round(baselineValue * f)),
      round(baselineValue * (1 - delta)),
      round(baselineValue * (1 + delta)),
    ]).filter((v) => v !== baselineValue);

    const samples: SensitivityProbeSample[] = values.map((value) => {
      const outcome = evaluateAt(withResource(inputs, definition.id, value));
      return {
        value,
        winningScore: outcome.score,
        recommendedStrategyId: outcome.strategyId,
      };
    });

    probes.push({
      inputId: definition.id,
      label: definition.label,
      kind: 'resource',
      baselineValue,
      samples,
      influence: localInfluence(samples, baselineValue, baseline.score, delta),
      flip: nearestFlip(samples, baselineValue, baseline.strategyId, labelFor),
    });
  }

  /* --- objective weights --- */
  for (const objective of scenario.objectives) {
    const baselineValue = inputs.priorities[objective.id] ?? objective.weight;
    const values = uniqueSorted([
      clamp01(round(baselineValue - weightDelta)),
      clamp01(round(baselineValue + weightDelta)),
      0,
      clamp01(round(baselineValue + weightDelta * 2)),
    ]).filter((v) => v !== baselineValue);

    const samples: SensitivityProbeSample[] = values.map((value) => {
      const outcome = evaluateAt(withPriority(inputs, scenario, objective.id, value));
      return {
        value,
        winningScore: outcome.score,
        recommendedStrategyId: outcome.strategyId,
      };
    });

    probes.push({
      inputId: objective.id,
      label: `${objective.label} priority`,
      kind: 'priority',
      baselineValue,
      samples,
      influence: neighbourInfluence(samples, baselineValue, baseline.score, weightDelta),
      flip: nearestFlip(samples, baselineValue, baseline.strategyId, labelFor),
    });
  }

  /* --- rank --- */
  const total = probes.reduce((sum, probe) => sum + probe.influence, 0);
  // Zero-influence probes are KEPT. An empty bar next to "Recovery Budget"
  // says "not binding at this operating point", which is a finding; dropping
  // the row would just look like we forgot to test it. Its flip point still
  // appears under `flips`.
  const drivers: SensitivityDriver[] =
    total <= 1e-9
      ? []
      : probes
          .map((probe) => ({
            label: probe.label,
            inputId: probe.inputId,
            weight: probe.influence / total,
          }))
          .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));

  const flips = probes
    .map((probe) => probe.flip)
    .filter((flip): flip is SensitivityFlip => flip !== undefined);

  return {
    ok: true,
    value: {
      baselineStrategyId: baseline.strategyId,
      baselineLabel: labelFor(baseline.strategyId),
      baselineScore: baseline.score,
      drivers,
      probes,
      flips,
      evaluations,
    },
  };
}

/* --------------------------------------------------------------------------- *
 * Measures
 * --------------------------------------------------------------------------- */

/**
 * Local influence: how far the best achievable score moves for a small step
 * either side of the current value. Deliberately local — a sweep to zero would
 * measure "what if we had none of this", which is a different question and is
 * already answered by `flip`.
 */
function localInfluence(
  samples: readonly SensitivityProbeSample[],
  baselineValue: number,
  baselineScore: number,
  delta: number,
): number {
  const low = round(baselineValue * (1 - delta));
  const high = round(baselineValue * (1 + delta));
  return neighbourhoodMean(samples, [low, high], baselineScore);
}

function neighbourInfluence(
  samples: readonly SensitivityProbeSample[],
  baselineValue: number,
  baselineScore: number,
  delta: number,
): number {
  const low = clamp01(round(baselineValue - delta));
  const high = clamp01(round(baselineValue + delta));
  return neighbourhoodMean(samples, [low, high], baselineScore);
}

function neighbourhoodMean(
  samples: readonly SensitivityProbeSample[],
  values: readonly number[],
  baselineScore: number,
): number {
  const deltas: number[] = [];
  for (const value of values) {
    const sample = samples.find((s) => s.value === value);
    if (!sample) continue;
    deltas.push(Math.abs(sample.winningScore - baselineScore));
  }
  if (deltas.length === 0) return 0;
  return deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
}

/**
 * The flip nearest the baseline — the smallest change that would alter the
 * decision. Sorted by distance so the answer is "how far would this have to
 * move", not "does it ever move".
 */
function nearestFlip(
  samples: readonly SensitivityProbeSample[],
  baselineValue: number,
  baselineStrategyId: string | null,
  labelFor: (id: string | null) => string,
): SensitivityFlip | undefined {
  const changed = samples
    .filter((sample) => sample.recommendedStrategyId !== baselineStrategyId)
    .sort(
      (a, b) =>
        Math.abs(Number(a.value) - baselineValue) - Math.abs(Number(b.value) - baselineValue) ||
        Number(a.value) - Number(b.value),
    );
  const flip = changed[0];
  if (!flip) return undefined;
  return {
    value: flip.value,
    from: baselineStrategyId ?? 'none',
    to: flip.recommendedStrategyId,
    toLabel: labelFor(flip.recommendedStrategyId),
    direction: Number(flip.value) < baselineValue ? 'below' : 'above',
  };
}

/* --------------------------------------------------------------------------- *
 * Numeric helpers — rounding keeps sample values comparable by equality, which
 * the neighbourhood lookup depends on.
 * --------------------------------------------------------------------------- */

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * CAUSALIS / VECTRA — Simulation data contract (integration boundary).
 *
 * This is the interface the simulation engine produces and the visualization
 * layer consumes. The view never computes domain metrics (temperature,
 * viability, scoring, feasibility) itself.
 *
 * The generic decision primitives — scenario, actions, constraints, objectives,
 * metrics, resources, state — live in `src/domain` and are re-exported here so
 * every consumer keeps a single import site.
 *
 * Identity rule: entities, routes, facilities, resources and events are ALWAYS
 * referenced by stable string id — never by array index, position or timestamp.
 */

export * from '../domain';

import type {
  ConstraintViolation,
  EntityState,
  FeasibilityReport,
  MetricDelta,
  ObjectiveContribution,
  ResourceState,
  ScenarioConfig,
  SensitivityDriver,
  SensitivityReport,
  SimulationEvent,
  SimulationInputs,
  StepMetrics,
} from '../domain';

/* --------------------------------------------------------------------------- *
 * Steps — immutable keyframes
 * --------------------------------------------------------------------------- */

export interface SimulationStep {
  /** Simulation minutes, ascending. Step 0 is t0. */
  timestamp: number;
  entities: EntityState[];
  resources: ResourceState[];
  metrics: StepMetrics;
  /** Events in the interval (previousStep.timestamp, this.timestamp]. */
  events: SimulationEvent[];
}

/* --------------------------------------------------------------------------- *
 * Analytics
 * --------------------------------------------------------------------------- */

/** From the analytics layer. Scores are -1..2 (⚠ = -1..0, ✓ = 1, ✓✓ = 2). */
export interface TradeoffRow {
  strategy: string;
  scores: Record<string, number>;
}

/* --------------------------------------------------------------------------- *
 * Outcome + recommendation
 * --------------------------------------------------------------------------- */

export interface SimulationOutcome {
  strategy: string;
  status: 'success' | 'partial' | 'failed';
  summary: string;
  finalMetrics: StepMetrics;
}

export interface RecommendationReason {
  text: string;
  kind: 'objective' | 'constraint' | 'tradeoff';
  /** Present for 'objective' reasons: the arithmetic the text describes. */
  contribution?: ObjectiveContribution;
}

export interface RejectedAlternative {
  strategyId: string;
  label: string;
  reason: string;
  feasible: boolean;
  score?: number;
}

export interface Recommendation {
  strategyId: string;
  label: string;
  score: number;
  /** Full breakdown; contributions sum to the pre-penalty score. */
  contributions: ObjectiveContribution[];
  /** Total soft-constraint penalty subtracted from the summed contributions. */
  penalty: number;
  reasons: RecommendationReason[];
  tradeoffs: TradeoffRow[];
  rejectedAlternatives: RejectedAlternative[];
}

/** The whole decision space for one set of inputs. */
export interface ScenarioEvaluation {
  scenario: ScenarioConfig;
  inputs: SimulationInputs;
  feasibleStrategies: string[];
  /** Statically infeasible AND trajectory-infeasible strategies. */
  infeasibleStrategies: FeasibilityReport[];
  /** One per statically-feasible strategy, all from the same initial state. */
  results: SimulationResult[];
  recommendation: Recommendation | null;
  /**
   * Populated only when sensitivity analysis was explicitly requested — it
   * costs many more evaluations than the decision itself.
   */
  sensitivity?: SensitivityReport;
}

/* --------------------------------------------------------------------------- *
 * Run identity + result
 * --------------------------------------------------------------------------- */

/** Identity + inputs for a run. Makes comparison and deterministic replay clean. */
export interface RunIdentity {
  runId: string;
  runNumber: number;
  label: string;
  /** Echoed configuration: safetyPriority, budget, etc. */
  inputs: Record<string, string | number>;
  /** Structured inputs as handed to the engine. */
  structuredInputs: SimulationInputs;
  /**
   * The seed actually used. Same scenario + inputs + strategy + seed +
   * engineVersion produces a structurally identical result.
   */
  seed: number;
  engineVersion: string;
  schemaVersion: number;
}

/**
 * Snapshot of decision impact: state at the first decision event vs the
 * projected final state. Drives the "before vs after" panel.
 */
export interface DecisionImpact {
  decisionEventId: string;
  before: StepMetrics;
  projected: StepMetrics;
  riskBefore?: string;
  riskAfter?: string;
  /** Per-metric deltas, interpreted via each metric's own direction. */
  changes: MetricDelta[];
}

export interface SimulationResult {
  run: RunIdentity;
  scenario: ScenarioConfig;
  /** Action that was simulated. */
  strategy: string;
  strategyLabel: string;
  /** Total simulation minutes. */
  duration: number;
  steps: SimulationStep[];
  /** Flattened, sorted, unique; a superset of the per-step events. */
  events: SimulationEvent[];
  outcome: SimulationOutcome;
  /** Static + trajectory feasibility for the simulated strategy. */
  feasibility: FeasibilityReport;
  /** Every violation observed, both scopes. Mirrors `feasibility.violations`. */
  violations: ConstraintViolation[];
  decisionImpact?: DecisionImpact;
  sensitivity?: SensitivityDriver[];
  tradeoffs?: TradeoffRow[];
  /** Set only on results produced through `evaluateScenario`. */
  recommendation?: Recommendation;
}

/** Narrative summary of the run at a point in time. NOT authoritative state. */
export type NarrativePhase =
  | 'NORMAL'
  | 'FAILURE'
  | 'DETERIORATING'
  | 'INTERVENTION'
  | 'RECOVERY'
  | 'DELIVERY';

export const SCHEMA_VERSION = 2;

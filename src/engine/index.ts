/**
 * Public engine API — the integration boundary.
 *
 *   runSimulation(scenario, inputs, strategy, options?)  -> one strategy
 *   evaluateScenario(scenario, inputs, options?)         -> the whole decision space
 *
 * Nothing above this line imports React; nothing below it renders anything.
 */

export { runSimulation, ENGINE_VERSION, type RunOutput } from './runner';
export { evaluateScenario, expandAction } from './candidateEvaluator';
export { recommend, type ScoredCandidate } from './recommendation';
export { analyzeSensitivity, type SensitivityOptions } from './sensitivity';
export {
  checkStaticFeasibility,
  evaluateTrajectoryConstraints,
  isTrajectoryFeasible,
  validateInputs,
  validateScenario,
  type StaticFeasibility,
} from './feasibility';
export {
  scoreTrajectory,
  toTradeoffScores,
  effectiveWeight,
  type StrategyScore,
} from './scoring';
export { aggregateTrajectory, buildDecisionImpact, metricSeries, riskLabel } from './metrics';
export {
  simulateTrajectory,
  buildInitialState,
  switchRoute,
  type Trajectory,
  type TrajectoryFrame,
} from './simulator';
export { applyTransition, type TransitionEnv } from './transitions';
export { framesToSteps, toEntityStates, toResourceStates } from './adapter';
export { canonicalSerialize, deriveSeed, hashString, mulberry32 } from './rng';
export {
  EngineException,
  engineError,
  unwrap,
  type EngineError,
  type EngineErrorKind,
  type EngineResult,
} from './errors';
export {
  createColdChainModels,
  type ColdChainModelConfig,
} from './models/coldChainModels';

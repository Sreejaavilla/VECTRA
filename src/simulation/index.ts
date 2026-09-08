/** Public surface of the simulation layer. */

export * from './types';
export {
  coldChainScenario,
  makeColdChainScenario,
  DEMO_SCENARIOS,
  COLD_CHAIN,
  DEFAULT_PRIORITIES,
  OBJECTIVE_IDS,
  STRATEGY_LABELS,
  type StrategyId,
  type DisruptionConfig,
  type DemoScenario,
  type DemoControls,
} from './scenarios/coldChain';
export {
  analyzeSensitivity,
  evaluateScenario,
  runSimulation,
  ENGINE_VERSION,
  EngineException,
  canonicalSerialize,
  unwrap,
  type EngineError,
  type EngineResult,
  type RunOutput,
} from '../engine';
export {
  useSimulationPlayback,
  PLAYBACK_SPEEDS,
  type PlaybackSpeed,
  type SimulationPlayback,
} from './useSimulationPlayback';
export {
  classifyEvent,
  formatSimulationTime,
  getActiveEvents,
  getEntityVisualState,
  getEventsUpTo,
  getFocusTarget,
  getMetricSeries,
  getNarrativePhase,
  getRoutePoint,
  getStateAtTime,
  resolveEntityHeading,
  resolveEntityPosition,
  routePolyline,
  FOCUS_WINDOW_MINUTES,
  type EntityVisual,
  type FocusTarget,
  type MetricPoint,
  type StateAtTime,
} from './selectors';

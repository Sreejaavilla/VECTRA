/** Public surface of the simulation-visualization layer for the integration engineer. */

export * from './types';
export {
  runMockSimulation,
  coldChainScenario,
  STRATEGY_LABELS,
  isDecisionType,
  type StrategyId,
  type WhatIfInputs,
} from './mockEngine';
export {
  useSimulationPlayback,
  PLAYBACK_SPEEDS,
  type PlaybackSpeed,
  type SimulationPlayback,
} from './useSimulationPlayback';
export * from './selectors';

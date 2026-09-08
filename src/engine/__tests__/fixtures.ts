/** Shared helpers for engine and view tests. */

import type {
  ScenarioEvaluation,
  SimulationInputs,
  SimulationResult,
} from '../../simulation/types';
import { coldChainScenario, DEFAULT_PRIORITIES } from '../../simulation/scenarios/coldChain';
import { evaluateScenario, runSimulation } from '../index';

export { coldChainScenario };

export function makeInputs(overrides: Partial<SimulationInputs> = {}): SimulationInputs {
  return {
    resources: {},
    constraints: {},
    priorities: DEFAULT_PRIORITIES,
    ...overrides,
  };
}

/** Run one strategy, failing the test loudly if the engine refused. */
export function run(
  strategy: string,
  inputs: SimulationInputs = makeInputs(),
  runNumber = 1,
): SimulationResult {
  const outcome = runSimulation(coldChainScenario, inputs, strategy, { runNumber });
  if (!outcome.ok) {
    throw new Error(`runSimulation(${strategy}) failed: ${outcome.error.message}`);
  }
  return outcome.value.result;
}

export function evaluate(inputs: SimulationInputs = makeInputs()): ScenarioEvaluation {
  const outcome = evaluateScenario(coldChainScenario, inputs);
  if (!outcome.ok) throw new Error(`evaluateScenario failed: ${outcome.error.message}`);
  return outcome.value;
}

export const ALL_STRATEGIES = [
  'continue',
  'reroute_storage',
  'emergency_interception',
  'hybrid',
] as const;

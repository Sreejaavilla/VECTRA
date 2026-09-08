/**
 * Combinatorial parameter expansion.
 *
 * A parameterized action is a family of candidates that differ only in a
 * configuration value. The engine simulates every member, keeps the best per
 * base action, and reports both the strategy AND the configuration — the answer
 * to "what settings", not just "which strategy". The swept variant ids are an
 * internal concern and must never leave the engine.
 */

import { describe, expect, it } from 'vitest';
import type { ActionDefinition } from '../../domain';
import { canonicalSerialize, evaluateScenario, expandAction } from '../index';
import { coldChainScenario, evaluate, makeInputs } from './fixtures';

function baseAction(overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return {
    id: 'act',
    label: 'Act',
    decisionTimeMinutes: 40,
    preconditions: [],
    resourceRequirements: [],
    transitions: [],
    emittedEvents: [],
    costModel: {},
    ...overrides,
  };
}

describe('expandAction', () => {
  it('passes a plain action through untouched', () => {
    const action = baseAction();
    expect(expandAction(action)).toEqual([action]);
  });

  it('produces the Cartesian product of its parameters', () => {
    const variants = expandAction(
      baseAction({
        parameters: {
          a: { type: 'number', values: [1, 2] },
          b: { type: 'string', values: ['x', 'y', 'z'] },
        },
      }),
    );
    expect(variants).toHaveLength(6);
    expect(variants.map((v) => v.parameterValues)).toEqual([
      { a: 1, b: 'x' },
      { a: 1, b: 'y' },
      { a: 1, b: 'z' },
      { a: 2, b: 'x' },
      { a: 2, b: 'y' },
      { a: 2, b: 'z' },
    ]);
  });

  it('gives each variant a unique id and a baseId back to the original', () => {
    const variants = expandAction(
      baseAction({ parameters: { n: { type: 'number', values: [1, 2, 3] } } }),
    );
    expect(new Set(variants.map((v) => v.id)).size).toBe(3);
    for (const variant of variants) expect(variant.baseId).toBe('act');
  });

  it('applies a well-known parameter to the action definition itself', () => {
    const variants = expandAction(
      baseAction({
        decisionTimeMinutes: 40,
        parameters: { decisionTimeMinutes: { type: 'number', values: [30, 50] } },
      }),
    );
    expect(variants.map((v) => v.decisionTimeMinutes)).toEqual([30, 50]);
  });

  it('is deterministic in its ordering', () => {
    const action = baseAction({
      parameters: {
        beta: { type: 'number', values: [2, 1] },
        alpha: { type: 'number', values: [1, 2] },
      },
    });
    expect(canonicalSerialize(expandAction(action))).toBe(
      canonicalSerialize(expandAction(action)),
    );
  });
});

describe('evaluateScenario with a swept action', () => {
  const evaluation = evaluate();

  it('surfaces only base action ids, never the swept variant ids', () => {
    const ids = [
      ...evaluation.results.map((r) => r.strategy),
      ...evaluation.feasibleStrategies,
      ...evaluation.infeasibleStrategies.map((r) => r.strategyId),
      evaluation.recommendation?.strategyId ?? '',
    ];
    for (const id of ids) expect(id).not.toContain('__');
  });

  it('scrubs the variant id from run identity too', () => {
    for (const result of evaluation.results) {
      expect(result.run.runId).not.toContain('__');
      expect(result.run.inputs.strategy).not.toContain('__');
      expect(result.run.inputs.strategy).toBe(result.strategy);
    }
  });

  it('returns one result per base action, not one per variant', () => {
    // coldChain has 4 base actions; two are swept 5 ways. Without pruning that
    // would be 12 results.
    expect(evaluation.results.length).toBe(coldChainScenario.actions.length);
    expect(new Set(evaluation.results.map((r) => r.strategy)).size).toBe(
      coldChainScenario.actions.length,
    );
  });

  it('reports the chosen configuration on a parameterized winner', () => {
    // Emergency Interception wins at the baseline and is swept on decision time.
    expect(evaluation.recommendation?.strategyId).toBe('emergency_interception');
    expect(evaluation.recommendation?.chosenParameters).toBeDefined();
    expect(evaluation.recommendation?.chosenParameters).toHaveProperty('decisionTimeMinutes');
  });

  it('mirrors the chosen configuration onto the winning result', () => {
    const winner = evaluation.results.find(
      (r) => r.strategy === evaluation.recommendation!.strategyId,
    )!;
    expect(winner.chosenParameters).toEqual(evaluation.recommendation!.chosenParameters);
  });

  it('leaves chosenParameters undefined for an unparameterized strategy', () => {
    const plain = evaluation.results.find((r) => r.strategy === 'reroute_storage')!;
    expect(plain.chosenParameters).toBeUndefined();
  });

  it('on a tie reports the most permissive decision time, not the earliest', () => {
    // Timestep is 5 min and the failure is at 35, so decision times 36/38/40
    // land in the same step and score identically. The reported answer is the
    // deadline — 40 — because a later decision that still works is the useful
    // fact.
    const chosen = evaluation.recommendation!.chosenParameters!.decisionTimeMinutes;
    expect(chosen).toBe(40);
  });

  it('a decision slipping past the deadline scores worse', () => {
    // Direct evidence the sweep is doing real work: minute 42 is not merely
    // pruned, it is genuinely inferior. Pin the decision time (strip the sweep)
    // so each scenario tests exactly one configuration.
    const hybrid = coldChainScenario.actions.find((a) => a.id === 'hybrid')!;
    const pinned = (minute: number): ActionDefinition => ({
      ...hybrid,
      parameters: undefined,
      decisionTimeMinutes: minute,
    });
    const scenarioWith = (a: ActionDefinition) => ({ ...coldChainScenario, actions: [a] });
    const onTime = evaluateScenario(scenarioWith(pinned(40)), makeInputs());
    const late = evaluateScenario(scenarioWith(pinned(42)), makeInputs());
    expect(onTime.ok && late.ok).toBe(true);
    if (onTime.ok && late.ok) {
      expect(late.value.recommendation!.score).toBeLessThan(
        onTime.value.recommendation!.score,
      );
    }
  });

  it('stays deterministic', () => {
    expect(canonicalSerialize(evaluate())).toBe(canonicalSerialize(evaluation));
  });

  it('does not change the recommendation relative to an unswept scenario', () => {
    // The sweep should refine the configuration, not overturn the decision.
    const unswept = {
      ...coldChainScenario,
      actions: coldChainScenario.actions.map((a) => ({ ...a, parameters: undefined })),
    };
    const plain = evaluateScenario(unswept, makeInputs());
    expect(plain.ok).toBe(true);
    if (plain.ok) {
      expect(plain.value.recommendation?.strategyId).toBe(
        evaluation.recommendation?.strategyId,
      );
    }
  });
});

/**
 * The replay guarantee.
 *
 * The claim is structural identity — same scenario + inputs + strategy + seed +
 * engineVersion yields a deep-equal result. Byte identity is a stronger property
 * we assert separately via `canonicalSerialize`, rather than conflating the two.
 */

import { describe, expect, it } from 'vitest';
import { canonicalSerialize, ENGINE_VERSION, runSimulation } from '../index';
import { ALL_STRATEGIES, coldChainScenario, evaluate, makeInputs, run } from './fixtures';

describe('determinism', () => {
  it('produces structurally identical results for identical arguments', () => {
    const inputs = makeInputs();
    const a = run('emergency_interception', inputs, 3);
    const b = run('emergency_interception', inputs, 3);
    expect(b).toEqual(a);
  });

  it('serializes canonically identically (the stronger reproducibility claim)', () => {
    const inputs = makeInputs();
    const a = run('hybrid', inputs, 7);
    const b = run('hybrid', inputs, 7);
    expect(canonicalSerialize(b)).toBe(canonicalSerialize(a));
  });

  it('replays exactly when the recorded seed is supplied back', () => {
    const inputs = makeInputs();
    const first = run('reroute_storage', inputs, 2);
    const replay = runSimulation(coldChainScenario, inputs, 'reroute_storage', {
      runNumber: 2,
      seed: first.run.seed,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(canonicalSerialize(replay.value.result)).toBe(canonicalSerialize(first));
  });

  it('derives a seed when none is supplied, and records it', () => {
    const result = run('continue');
    expect(Number.isInteger(result.run.seed)).toBe(true);
    expect(result.run.engineVersion).toBe(ENGINE_VERSION);
  });

  it('evaluates the whole decision space deterministically', () => {
    expect(canonicalSerialize(evaluate())).toBe(canonicalSerialize(evaluate()));
  });

  it('changes the result when the inputs change', () => {
    const rich = run('emergency_interception', makeInputs({ resources: { 'res-budget': 8 } }));
    const lean = run(
      'emergency_interception',
      makeInputs({ resources: { 'res-budget': 3 } }),
    );
    expect(lean.run.seed).not.toBe(rich.run.seed);
  });

  it('runs every declared strategy that is statically feasible', () => {
    for (const strategy of ALL_STRATEGIES) {
      const result = run(strategy);
      expect(result.steps.length).toBeGreaterThan(0);
      expect(result.events.some((e) => e.type === 'DELIVERY')).toBe(true);
    }
  });
});
